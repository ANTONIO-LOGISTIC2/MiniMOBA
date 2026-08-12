/**
 * enemy.js
 * ------------------------------------------------------
 * Enemy AI - an AI-controlled hero that hunts the player. In a PvP
 * match this exact same object is instead driven by the remote
 * guest's input (see isRemoteControlled below).
 *
 * Every stat, collision rule, crowd-control interaction, and hero
 * passive (Benedetta's Elapsed Daytime, recall, etc.) here is kept
 * byte-for-byte identical to Player so an AI or a real opponent is
 * always on a level playing field with the local player.
 *
 * Behavior:
 *  - Chases the player when within detection range
 *  - Attacks the player when in attack range
 *  - Has HP and can be killed
 *  - Respawns after a delay when killed
 * ------------------------------------------------------
 */

class Enemy {
  /**
   * @param {number} x - starting world x position
   * @param {number} y - starting world y position
   * @param {Object} mapBounds - { minX, minY, maxX, maxY }
   * @param {string} [spriteSrc] - path to the enemy's sprite sheet
   */
  constructor(x, y, mapBounds, spriteSrc = 'assets/player/hayabusa.png', character = 'hayabusa') {
    this.x = x;
    this.y = y;
    this.mapBounds = mapBounds;

    // Store spawn position for respawning
    this.spawnX = x;
    this.spawnY = y;

    // Character for skill selection
    this.character = character;

    // Movement
    this.speed = 160; // same as player
    this.drawWidth = 64;
    this.drawHeight = 64;
    this.direction = 'down';
    this.isMoving = false;
    // Skills such as Benedetta's combo control the caster's position.
    // The AI must not chase or attack until that animation releases it.
    this.isMovementLocked = false;

    // Collision box (used for map boundary clamping) - identical to Player.
    this.collisionWidth = 28;
    this.collisionHeight = 20;

    // PvP mode: when true, this entity is a real remote player (fed by
    // the guest's network input) instead of the AI. See update() below -
    // the whole "AI behavior" block is skipped in favor of
    // _updateFromRemoteInput(). game.js sets this and refreshes
    // remoteInput every time a network 'input' message arrives.
    this.isRemoteControlled = false;
    this.remoteInput = {
      moveX: 0, moveY: 0,
      attackPressed: false, attackHeld: false, attackReleased: false,
      skillPressed: [false, false, false],
      recallPressed: false
    };

    // Combat stats
    this.maxHp = 150;
    this.hp = this.maxHp;
    this.attackDamage = 15; // same as player
    this.attackRange = 68; // same as player
    this.attackCooldown = 500; // same as player
    this.cooldownRemaining = 0;
    this.detectionRange = 400; // how far it can see the player

    // Slow/debuff state (e.g. from Gusion's Sword Waves). 1 = full speed.
    this.slowMultiplier = 1;
    this.slowTimeRemaining = 0;

    // Crowd-control lock (e.g. from Benedetta's parry dash).
    this.isStunned = false;
    this.stunTimeRemaining = 0;

    // Respawn handling
    this.isDead = false;
    this.respawnTimer = 0;
    this.baseRespawnDelay = 3000; // 3 seconds base (same as player)
    this.respawnDelay = this.baseRespawnDelay;

    // Set true by abilities like Hayabusa's ultimate (Shadow Kill)
    // while their untargetable window is active - anything building a
    // hostile-target list should skip an entity with this set.
    this.isUntargetable = false;

    // Set true by Benedetta's Skill 2 (An Eye for an Eye) during her
    // parry stance - Combat.applyDamage/applySlow refuse to affect an
    // invulnerable entity. Mirrors Player exactly.
    this.isInvulnerable = false;
    this.isCrowdControlImmune = false;
    this.shield = 0;
    this.shieldTimeRemaining = 0;
    this.tookHitWhileInvulnerable = false;
    this.tookCrowdControlWhileInvulnerable = false;

    // Brief visual "punch" scale applied right after an attack lands -
    // same cosmetic feedback the player gets.
    this.attackFlashTimer = 0;

    // Benedetta passive: the Energy Bar is filled by holding Attack or
    // by combat, then spent to unleash Elapsed Daytime's dash slash.
    // Identical to Player so an AI/opponent Benedetta plays the same kit.
    this.energy = 0;
    this.maxEnergy = 90;
    this.energyChargeRate = 52;
    this.passiveChargeDelay = 180;
    this.passiveChargeHeldMs = 0;
    this.isChargingPassive = false;
    this.isPassiveDashing = false;
    this.passiveDashDuration = 110;
    this.passiveDashRange = 210;
    this.passiveDashDamage = 32;
    this.passiveDashTimer = 0;
    this.passiveDashFromX = 0;
    this.passiveDashFromY = 0;
    this.passiveDashToX = 0;
    this.passiveDashToY = 0;
    this.passiveDashHits = new Set();
    this.passiveAfterimages = [];
    this.passiveAfterimageTimer = 0;
    this.passiveDamageTargets = new Set();
    this.passiveDamageTargetWindow = 0;
    this.passiveDamageTargetWindowDuration = 900;

    // Recall ability - teleport back to base, same as the player's B key.
    // The AI uses simple heuristics to decide when to trigger it; a
    // remote-controlled opponent triggers it from their own B key.
    this.isRecalling = false;
    this.recallTimer = 0;
    this.recallDuration = 4000;

    // Match stats, for the post-game results screen. Kills here means
    // creep kills (used as the "assists" figure in the KDA display,
    // matching how the player's own creep kills are shown); hero
    // kills/deaths against the player are tracked from the player's
    // side (player.playerKills / player.deaths) and mirrored for the
    // enemy team rather than duplicated here.
    this.kills = 0;
    this.deaths = 0;

    // Skill system
    this.skillManager = new SkillManager(character);
    this.skillCooldowns = [0, 0, 0]; // AI decision timers for each skill slot
    this.skillDecisionIntervals = [2000, 3000, 5000]; // How often AI considers using each skill (ms)

    // Visuals
    this.sheetImage = new Image();
    this.sheetImage.src = spriteSrc;

    const ROW_MAP = { down: 0, left: 1, right: 2, up: 3 };
    this.animator = new SpriteAnimator(this.sheetImage, 64, 64, ROW_MAP, 4, 130);
  }

  /**
   * Updates enemy AI: chases player/creeps, attacks, uses skills, handles death/respawn.
   * @param {number} deltaTime - ms since last frame
   * @param {Player} player - the player instance to chase/attack
   * @param {Array} playerCreeps - array of player creep entities
   * @param {EffectSystem} effects - for attack visuals
   * @param {number} gameTime - total game time in ms
   */
  update(deltaTime, player, playerCreeps, effects, gameTime) {
    // Update respawn delay based on game time (same as player)
    // Increases by 3 seconds every 60 seconds, max 20 seconds
    const gameSeconds = gameTime / 1000;
    const additionalDelay = Math.floor(gameSeconds / 60) * 3000; // +3s per 60s
    this.respawnDelay = Math.min(this.baseRespawnDelay + additionalDelay, 20000); // Max 20s

    // Timers
    if (this.cooldownRemaining > 0) this.cooldownRemaining -= deltaTime;
    Combat.tickSlow(this, deltaTime);
    Combat.tickStun(this, deltaTime);
    Combat.tickShield(this, deltaTime);

    if (this.attackFlashTimer > 0) {
      this.attackFlashTimer = Math.max(0, this.attackFlashTimer - deltaTime);
    }

    if (this.passiveDamageTargetWindow > 0) {
      this.passiveDamageTargetWindow -= deltaTime;
      if (this.passiveDamageTargetWindow <= 0) {
        this.passiveDamageTargetWindow = 0;
        this.passiveDamageTargets.clear();
      }
    }

    // Recall channeling - identical rules to the player's.
    if (this.isRecalling) {
      this.recallTimer -= deltaTime;
      if (this.recallTimer <= 0) {
        this._completeRecall();
      }
    }

    // Update skill cooldowns and AI decision timers
    for (let i = 0; i < 3; i++) {
      if (this.skillCooldowns[i] > 0) {
        this.skillCooldowns[i] -= deltaTime;
      }
    }

    const skillTargets = [player, ...playerCreeps].filter(t => t.hp > 0 && !t.isUntargetable);
    const previousCombatSource = Combat.activeSource;
    Combat.activeSource = this;
    // Crowd control pauses normal casts, but thrown projectiles already
    // in flight continue independently.
    if (!this.isStunned || this.isDead || this.hp <= 0) {
      this.skillManager.update(deltaTime, skillTargets, effects, (target) => {
        if (target instanceof Creep) this.kills++;
      }, this);
    } else {
      this.skillManager.updatePersistentThrows(deltaTime, skillTargets, effects, (target) => {
        if (target instanceof Creep) this.kills++;
      }, this);
    }
    Combat.activeSource = previousCombatSource;

    // Death / respawn handling
    if (this.hp <= 0 && !this.isDead) {
      this.isDead = true;
      this.deaths++;
      this.respawnTimer = this.respawnDelay;
    }

    if (this.isDead) {
      this.respawnTimer -= deltaTime;
      this.isMoving = false;
      this.animator.update(deltaTime, this.direction, false);
      if (this.respawnTimer <= 0) {
        this._respawn();
      }
      return;
    }

    if (this.isStunned) {
      this.isMoving = false;
      this.animator.update(deltaTime, this.direction, false);
      return;
    }

    if (this.isMovementLocked) {
      this.isMoving = false;
      this.animator.update(deltaTime, this.direction, false);
      // Benedetta's passive dash is what SET isMovementLocked in the
      // first place, and updateElapsedDaytime() is the only code path
      // that ever clears it again (once the dash finishes). Returning
      // here without still calling it would leave her permanently
      // stuck - the lock she set to protect her own dash would end up
      // blocking the one thing that could ever release it.
      if (this.isPassiveDashing) {
        this.updateElapsedDaytime(deltaTime, false, false, skillTargets, effects, (target) => {
          if (target instanceof Creep) this.kills++;
        });
      }
      return;
    }

    // AI behavior - find nearest target (player or creeps)
    if (this.isRemoteControlled) {
      this._updateFromRemoteInput(deltaTime, effects, skillTargets);
      this.animator.update(deltaTime, this.direction, this.isMoving);
      return;
    }

    let target = null;
    let closestDist = Infinity;

    // Check player as target
    if (!player.isDead && !player.isUntargetable) {
      const distToPlayer = Combat.distance(this.x, this.y, player.x, player.y);
      if (distToPlayer < closestDist) {
        closestDist = distToPlayer;
        target = player;
      }
    }

    // Check player creeps as targets
    for (const creep of playerCreeps) {
      if (creep.hp > 0) {
        const distToCreep = Combat.distance(this.x, this.y, creep.x, creep.y);
        if (distToCreep < closestDist) {
          closestDist = distToCreep;
          target = creep;
        }
      }
    }

    // Simple AI recall heuristic: retreat to base to heal once badly
    // hurt and nothing is threatening it up close, same tool the human
    // player has available via the B key.
    if (!target || closestDist > this.detectionRange) {
      if (!this.isRecalling && this.hp < this.maxHp * 0.35) {
        this.startRecall();
      }
    }
    if (this.isRecalling && target && closestDist < this.attackRange * 2) {
      this._cancelRecall();
    }
    if (this.isRecalling) {
      this.isMoving = false;
      this.animator.update(deltaTime, this.direction, false);
      return;
    }

    if (target) {
      // Target found - chase and attack
      this._faceToward(target.x, target.y);

      // Benedetta AI: charge the passive while a target is in or near
      // attack range, and release it the instant it's full - the same
      // hold-then-release pattern the human player performs manually.
      this._updateAiPassive(deltaTime, closestDist, target, effects);
      if (this.isMovementLocked || this.isPassiveDashing) {
        this.isMoving = false;
        this.animator.update(deltaTime, this.direction, false);
        return;
      }

      // Try to use skills
      this._tryUseSkills(deltaTime, target, effects);

      // A skill may have just begun and taken control of movement.
      if (this.isMovementLocked) {
        this.isMoving = false;
        this.animator.update(deltaTime, this.direction, false);
        return;
      }

      if (closestDist <= this.attackRange) {
        // In attack range - stop and attack
        this.isMoving = false;
        if (this.cooldownRemaining <= 0) {
          const killed = Combat.applyDamage(target, this.attackDamage, this);
          effects.spawnAttackEffect(this.x, this.y, target.x, target.y, '#ff8a65');
          if (killed && target instanceof Creep) this.kills++;
          this.cooldownRemaining = this.attackCooldown;
          this.attackFlashTimer = 120;
        }
      } else {
        // Chase the target
        this._moveToward(target.x, target.y, deltaTime);
        this.isMoving = true;
      }
    } else {
      // No target - patrol toward player base
      this.isMoving = false;
    }

    this.animator.update(deltaTime, this.direction, this.isMoving);
  }

  /**
   * AI-only helper for Benedetta's passive: holds Charge whenever a
   * target is roughly nearby, and lets updateElapsedDaytime release the
   * dash the instant the bar fills - mirroring a player holding Attack.
   */
  _updateAiPassive(deltaTime, distToTarget, target, effects) {
    if (this.character !== 'benedetta') return;
    const wantsToCharge = distToTarget <= this.attackRange * 3;
    if (wantsToCharge && !this.isChargingPassive && !this.isPassiveDashing) {
      this.beginPassiveCharge();
    }
    const held = wantsToCharge && this.isChargingPassive;
    const released = this.isChargingPassive && !wantsToCharge;
    this.updateElapsedDaytime(deltaTime, held, released, [target], effects, (hitTarget) => {
      if (hitTarget instanceof Creep) this.kills++;
    });
  }

  /**
   * Moves the enemy toward a target point, then clamps it back inside
   * the map bounds - the same guard Player.update() applies every frame.
   */
  _moveToward(tx, ty, deltaTime) {
    const dx = tx - this.x;
    const dy = ty - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const step = this.speed * this.slowMultiplier * (deltaTime / 1000);

    if (dist <= step) {
      this.x = tx;
      this.y = ty;
    } else {
      this.x += (dx / dist) * step;
      this.y += (dy / dist) * step;
    }

    const clamped = Collision.clampToMap(
      this.x, this.y,
      this.collisionWidth / 2, this.collisionHeight / 2,
      this.mapBounds
    );
    this.x = clamped.x;
    this.y = clamped.y;
  }

  /**
   * Faces the enemy toward a world point.
   */
  _faceToward(tx, ty) {
    const dx = tx - this.x;
    const dy = ty - this.y;
    if (Math.abs(dx) > Math.abs(dy)) {
      this.direction = dx > 0 ? 'right' : 'left';
    } else if (dy !== 0) {
      this.direction = dy > 0 ? 'down' : 'up';
    }
  }

  /**
   * Starts the recall channel to teleport back to base. Identical to
   * Player.startRecall().
   */
  startRecall() {
    if (this.isDead || this.isRecalling) return false;
    this.isRecalling = true;
    this.recallTimer = this.recallDuration;
    this.isMoving = false;
    return true;
  }

  _completeRecall() {
    this.x = this.spawnX;
    this.y = this.spawnY;
    this.isRecalling = false;
    this.hp = this.maxHp;
  }

  _cancelRecall() {
    this.isRecalling = false;
    this.recallTimer = 0;
  }

  /**
   * Called when the enemy takes damage - cancels recall, same as the player.
   */
  onDamageTaken() {
    if (this.isRecalling) {
      this._cancelRecall();
    }
  }

  onDamageDealt(amount, target) {
    if (this.character !== 'benedetta') return;

    if (target && !this.passiveDamageTargets.has(target)) {
      this.passiveDamageTargets.add(target);
    }
    this.passiveDamageTargetWindow = this.passiveDamageTargetWindowDuration;

    const enemyMultiplier = 1 + Math.max(0, this.passiveDamageTargets.size - 1) * 0.3;
    this._gainEnergy(Math.max(6, amount * 0.45) * 3.8 * enemyMultiplier);
  }

  onBlockedDamage(amount, attacker) {
    if (this.character === 'benedetta' && this.isInvulnerable) {
      this.energy = this.maxEnergy;
    }
  }

  _gainEnergy(amount) {
    if (this.character !== 'benedetta' || this.isPassiveDashing) return;
    this.energy = Math.min(this.maxEnergy, this.energy + amount);
  }

  beginPassiveCharge() {
    if (this.character === 'benedetta' && !this.isDead && !this.isMovementLocked) {
      this.isChargingPassive = true;
      this.passiveChargeHeldMs = 0;
    }
  }

  /**
   * Identical to Player.updateElapsedDaytime() - kept as its own copy
   * (rather than a shared mixin) so Enemy has zero extra dependencies,
   * matching how the rest of this file mirrors player.js.
   */
  updateElapsedDaytime(deltaTime, held, released, hostiles, effects, onHitKill) {
    if (this.character !== 'benedetta') return;
    if (this.isDead) {
      this.isChargingPassive = false;
      this.isPassiveDashing = false;
      this.isMovementLocked = false;
      this.passiveChargeHeldMs = 0;
      return;
    }
    for (const image of this.passiveAfterimages) image.life -= deltaTime;
    this.passiveAfterimages = this.passiveAfterimages.filter(image => image.life > 0);

    if (this.isChargingPassive && held) {
      const heldBefore = this.passiveChargeHeldMs;
      this.passiveChargeHeldMs += deltaTime;
      const chargeTime = Math.max(0, this.passiveChargeHeldMs - this.passiveChargeDelay)
        - Math.max(0, heldBefore - this.passiveChargeDelay);
      this._gainEnergy(this.energyChargeRate * chargeTime / 1000);
      if (Math.floor((this.energy * 10) % 120) < 8) effects.spawnAttackEffect(this.x, this.y, this.x, this.y, '#08571a');
    }
    if (released && this.isChargingPassive) {
      this.isChargingPassive = false;
      this.passiveChargeHeldMs = 0;
      if (this.energy >= this.maxEnergy) this._startPassiveDash();
    }

    if (!this.isPassiveDashing) return;
    this.passiveDashTimer += deltaTime;
    const t = Math.min(1, this.passiveDashTimer / this.passiveDashDuration);
    this.x = this.passiveDashFromX + (this.passiveDashToX - this.passiveDashFromX) * t;
    this.y = this.passiveDashFromY + (this.passiveDashToY - this.passiveDashFromY) * t;
    this.passiveAfterimageTimer += deltaTime;
    while (this.passiveAfterimageTimer >= 45) {
      this.passiveAfterimageTimer -= 45;
      this.passiveAfterimages.push({ x: this.x, y: this.y, life: 210, maxLife: 210 });
      effects.spawnAttackEffect(this.x - 20, this.y, this.x + 20, this.y, '#032506');
    }
    for (const target of hostiles) {
      if (!target || target.hp <= 0 || this.passiveDashHits.has(target)) continue;
      if (Combat.distance(this.x, this.y, target.x, target.y) <= 30 + (target.drawWidth || 40) / 2) {
        this.passiveDashHits.add(target);
        const killed = Combat.applyDamage(target, this.passiveDashDamage, this);
        effects.spawnAttackEffect(this.x, this.y, target.x, target.y, '#086718');
        if (killed && onHitKill) onHitKill(target);
      }
    }
    if (t >= 1) {
      this.isPassiveDashing = false;
      this.isMovementLocked = false;
    }
  }

  /**
   * Starts the passive dash. Uses the remote guest's current movement
   * input when this entity is player-controlled over the network,
   * otherwise falls back to current facing direction (the same
   * fallback Player uses when no movement key is held).
   */
  _startPassiveDash() {
    if (this.isDead) return;
    const fallback = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
    let move = { x: 0, y: 0 };
    if (this.isRemoteControlled) {
      move = { x: this.remoteInput.moveX || 0, y: this.remoteInput.moveY || 0 };
    }
    const direction = (move.x || move.y) ? move : fallback[this.direction] || fallback.down;
    this.passiveDashFromX = this.x;
    this.passiveDashFromY = this.y;
    const clamped = Collision.clampToMap(this.x + direction.x * this.passiveDashRange, this.y + direction.y * this.passiveDashRange,
      this.collisionWidth / 2, this.collisionHeight / 2, this.mapBounds);
    this.passiveDashToX = clamped.x;
    this.passiveDashToY = clamped.y;
    this.passiveDashTimer = 0;
    this.passiveAfterimageTimer = 0;
    this.passiveDashHits.clear();
    this.isPassiveDashing = true;
    this.isMovementLocked = true;
    this.energy = 0;
  }

  /**
   * PvP mode: applies whatever the guest's browser last sent instead
   * of running AI decision logic. game.js overwrites `this.remoteInput`
   * every time a network 'input' message arrives; this just consumes
   * it once per frame, the same way Player.update() consumes local
   * keyboard/mouse input.
   * @param {number} deltaTime
   * @param {EffectSystem} effects
   * @param {Array} skillTargets - valid attack/skill targets this frame
   */
  _updateFromRemoteInput(deltaTime, effects, skillTargets) {
    const input = this.remoteInput;

    // Recall (B key on the guest's keyboard).
    if (input.recallPressed) {
      input.recallPressed = false;
      if (this.startRecall()) {
        effects.spawnAttackEffect(this.x, this.y, this.x, this.y, '#81d4fa');
      }
    }

    const moveX = input.moveX || 0;
    const moveY = input.moveY || 0;
    this.isMoving = moveX !== 0 || moveY !== 0;

    // Moving cancels an active recall, exactly like the local player.
    if (this.isRecalling && this.isMoving) {
      this._cancelRecall();
    }

    if (this.isMoving) {
      const step = this.speed * this.slowMultiplier * (deltaTime / 1000);
      this.x += moveX * step;
      this.y += moveY * step;

      if (Math.abs(moveX) > Math.abs(moveY)) {
        this.direction = moveX > 0 ? 'right' : 'left';
      } else if (moveY !== 0) {
        this.direction = moveY > 0 ? 'down' : 'up';
      }

      // Keep the remote hero inside the map, same guard Player uses locally.
      const clamped = Collision.clampToMap(this.x, this.y, this.collisionWidth / 2, this.collisionHeight / 2, this.mapBounds);
      this.x = clamped.x;
      this.y = clamped.y;
    }

    // Benedetta: the guest's Attack button/space is sent as a proper
    // held/pressed/released trio (see pvp-guest.js._sendInput), so her
    // Charge-and-release passive works identically over the network.
    if (this.character === 'benedetta') {
      if (input.attackPressed) this.beginPassiveCharge();
      const wasFullyCharged = this.energy >= this.maxEnergy;
      this.updateElapsedDaytime(deltaTime, input.attackHeld, input.attackReleased, skillTargets, effects, (t) => {
        if (t instanceof Creep) this.kills++;
      });
      input.attackPressed = false;
      const released = input.attackReleased;
      input.attackReleased = false;
      if (released && !wasFullyCharged) {
        this._remoteBasicAttack(skillTargets, effects);
      }
    } else if (input.attackPressed) {
      input.attackPressed = false;
      this._remoteBasicAttack(skillTargets, effects);
    }

    // Skill casts: same one-shot-per-press pattern as the local player.
    for (let slot = 1; slot <= 3; slot++) {
      if (input.skillPressed[slot - 1]) {
        input.skillPressed[slot - 1] = false;
        this.skillManager.tryCast(slot, this, effects, (t) => {
          if (t instanceof Creep) this.kills++;
        }, skillTargets);
      }
    }
  }

  /** Nearest valid target within range, one-shot per press - shared by both remote-attack paths. */
  _remoteBasicAttack(skillTargets, effects) {
    if (this.cooldownRemaining > 0) return;
    let target = null;
    let closestDist = Infinity;
    for (const candidate of skillTargets) {
      const dist = Combat.distance(this.x, this.y, candidate.x, candidate.y);
      if (dist <= this.attackRange && dist < closestDist) {
        closestDist = dist;
        target = candidate;
      }
    }
    if (target) {
      const killed = Combat.applyDamage(target, this.attackDamage, this);
      effects.spawnAttackEffect(this.x, this.y, target.x, target.y, '#ff8a65');
      if (killed && target instanceof Creep) this.kills++;
      this.cooldownRemaining = this.attackCooldown;
      this.attackFlashTimer = 120;
      this._faceToward(target.x, target.y);
    }
  }

  /**
   * AI skill usage logic - tries to cast skills when ready and in range.
   */
  _tryUseSkills(deltaTime, target, effects) {
    // Check each skill slot
    for (let slot = 1; slot <= 3; slot++) {
      const skillIndex = slot - 1;
      
      // Update AI decision timer for this skill
      if (this.skillCooldowns[skillIndex] <= 0) {
        // AI is ready to consider using this skill
        const skill = this.skillManager.skills[skillIndex];
        
        // Check if skill is ready (off cooldown)
        if (skill.isReady) {
          // Distance to target
          const distToTarget = Combat.distance(this.x, this.y, target.x, target.y);
          
          // AI decision: use skill if in reasonable range
          // Skill 1: use if target is within 400px
          // Skill 2: use if target is within 350px
          // Skill 3: use if target is within 200px or enemy needs repositioning
          let shouldCast = false;
          
          if (slot === 1 && distToTarget <= 400) {
            shouldCast = true;
          } else if (slot === 2 && distToTarget <= 350) {
            shouldCast = true;
          } else if (slot === 3 && distToTarget <= 200) {
            shouldCast = true;
          }
          
          if (shouldCast) {
            // Cast the skill
            const skillTargets = [target];
            this.skillManager.tryCast(slot, this, effects, (t) => {
              if (t instanceof Creep) this.kills++;
            }, skillTargets);
            
            // Set AI decision cooldown
            this.skillCooldowns[skillIndex] = this.skillDecisionIntervals[skillIndex];
          }
        }
      }
    }
  }

  /**
   * Respawns the enemy at full health. Resets every piece of transient
   * combat/skill state, mirroring Player._respawn() exactly.
   */
  _respawn() {
    this.hp = this.maxHp;
    this.x = this.spawnX;
    this.y = this.spawnY;
    this.isDead = false;
    this.cooldownRemaining = 0;
    this.isUntargetable = false;
    this.isMovementLocked = false;
    this.isRecalling = false;
    this.recallTimer = 0;
    this.isInvulnerable = false;
    this.isCrowdControlImmune = false;
    this.shield = 0;
    this.shieldTimeRemaining = 0;
    this.tookHitWhileInvulnerable = false;
    this.tookCrowdControlWhileInvulnerable = false;
    this.isStunned = false;
    this.stunTimeRemaining = 0;
    this.slowMultiplier = 1;
    this.slowTimeRemaining = 0;
    this.energy = 0;
    this.isChargingPassive = false;
    this.isPassiveDashing = false;
    this.passiveChargeHeldMs = 0;
    this.passiveDamageTargets.clear();
    this.passiveDamageTargetWindow = 0;

    // Reset skills on respawn - but don't yank away an already-planted,
    // still-active persistent effect (Benedetta's ultimate ground trail,
    // or an in-flight thrown projectile) out from under itself just
    // because the fresh kit below replaces every skill instance; the
    // SkillManager's own death-handling already keeps these ticking
    // and freezes their cooldown correctly, so only that specific
    // still-active skill gets carried over into the new kit.
    const previousSkillManager = this.skillManager;
    this.skillManager = new SkillManager(this.character);
    for (let i = 0; i < this.skillManager.skills.length; i++) {
      const oldSkill = previousSkillManager.skills[i];
      if (oldSkill && previousSkillManager._survivesCasterDeath(oldSkill)) {
        this.skillManager.skills[i] = oldSkill;
      }
    }
    this.skillCooldowns = [0, 0, 0];
  }

  /**
   * Draws the enemy, its indicators, and health bar - matching every
   * visual cue Player.draw() shows (attack range ring, recall ring,
   * attack "punch" scale, slow/stun icons) so both heroes read the
   * same way on screen.
   */
  draw(ctx, screenX, screenY) {
    screenY -= Combat.getAirborneLift(this);

    for (const image of this.passiveAfterimages) {
      ctx.save();
      ctx.globalAlpha = (image.life / image.maxLife) * 0.45;
      ctx.fillStyle = '#f5c34d';
      ctx.beginPath();
      ctx.ellipse(screenX + (image.x - this.x), screenY + (image.y - this.y), 15, 23, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Attack range indicator - same dashed ring the player gets.
    if (!this.isDead) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 138, 101, 0.55)';
      ctx.setLineDash([6, 6]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(screenX, screenY, this.attackRange, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    if (!this.isDead && this.slowTimeRemaining > 0) {
      Combat.drawSlowIndicator(ctx, screenX, screenY + this.drawHeight / 2 - 6);
    }
    if (!this.isDead && this.isStunned) {
      Combat.drawStunIndicator(ctx, screenX, screenY - this.drawHeight / 2 - 24);
    }

    // Recall channeling indicator - identical ring/text to the player's.
    if (this.isRecalling) {
      ctx.save();
      const progress = 1 - (this.recallTimer / this.recallDuration);
      const radius = 45;

      ctx.strokeStyle = 'rgba(255, 138, 101, 0.3)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(screenX, screenY, radius, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = '#ff8a65';
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(screenX, screenY, radius, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * progress));
      ctx.stroke();

      ctx.fillStyle = '#fff';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`Recalling ${Math.ceil(this.recallTimer / 1000)}s`, screenX, screenY - 55);
      ctx.restore();
    }

    // Soft shadow beneath the enemy, matching the player's.
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.beginPath();
    ctx.ellipse(screenX, screenY + 20, 16, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    if (this.isDead) {
      ctx.globalAlpha = 0.35;
    }

    // Same attack "punch" scale the player gets right after a hit.
    let width = this.drawWidth;
    let height = this.drawHeight;
    if (this.attackFlashTimer > 0) {
      const scale = 1 + 0.15 * (this.attackFlashTimer / 120);
      width *= scale;
      height *= scale;
    }

    if (this.sheetImage.complete) {
      this.animator.draw(ctx, screenX, screenY, width, height);
    }
    ctx.restore();

    // Health bar (skip while dead) - same vertical offset as the player.
    if (!this.isDead) {
      Combat.drawHealthBar(ctx, screenX, screenY - this.drawHeight / 2 - 10, 46, this.hp, this.maxHp, '#ef5350', this.shield);
    } else {
      // Respawn countdown
      ctx.save();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(
        `Respawning in ${Math.ceil(this.respawnTimer / 1000)}s`,
        screenX,
        screenY - this.drawHeight / 2 - 14
      );
      ctx.restore();
    }
  }
}
