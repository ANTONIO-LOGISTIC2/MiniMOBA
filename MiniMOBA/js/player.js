/**
 * player.js
 * ------------------------------------------------------
 * The Player class: owns position, speed, collision box,
 * and its own SpriteAnimator instance. Reads movement input
 * from the shared InputHandler and updates its world position
 * every frame, then keeps itself inside the map using Collision.
 * ------------------------------------------------------
 */

class Player {
  /**
   * @param {number} x - starting world x position (center)
   * @param {number} y - starting world y position (center)
   * @param {Object} mapBounds - { minX, minY, maxX, maxY }
   * @param {string} [spriteSrc] - path to the chosen hero's sprite
   *        sheet (picked on the main menu's character select screen).
   *        Defaults to Gusion if nothing is passed in.
   */
  constructor(x, y, mapBounds, spriteSrc = 'assets/player/gusion.png') {
    this.x = x;
    this.y = y;
    this.mapBounds = mapBounds;
    this.character = ['gusion', 'hayabusa', 'benedetta', 'chou'].find(name => spriteSrc.includes(name)) || 'gusion';

    // Remember the starting point so the player can respawn here.
    this.spawnX = x;
    this.spawnY = y;

    // Movement
    this.speed = 160; // pixels per second (slightly faster than enemy)

    // Collision box (used for map boundary clamping)
    this.collisionWidth = 28;
    this.collisionHeight = 20;

    // Rendered sprite size (can be larger than the collision box
    // for visual "hitbox forgiveness", common in MOBA-style games)
    this.drawWidth = 64;
    this.drawHeight = 64;

    // Facing direction, used to pick the correct animation row.
    this.direction = 'down';
    this.isMoving = false;

    // Skills with a committed animation (such as Benedetta's slashes
    // and parry dash) set this while they control the player's position.
    // Input movement is ignored until the animation completes.
    this.isMovementLocked = false;

    // ---- Combat stats ----
    this.maxHp = 150;
    this.hp = this.maxHp;
    this.attackDamage = 15;
    this.attackRange = 68; // reduced by 25% (was 90)
    this.attackCooldown = 500; // ms between attacks
    this.cooldownRemaining = 0;
    this.kills = 0; // creep kills
    this.playerKills = 0; // enemy hero kills
    this.deaths = 0; // total deaths

    // Respawn handling (used when hp hits 0)
    this.isDead = false;
    this.respawnTimer = 0;
    this.baseRespawnDelay = 3000; // 3 seconds base
    this.respawnDelay = this.baseRespawnDelay;

    // Set true by abilities like Hayabusa's ultimate (Shadow Kill)
    // while their untargetable window is active - anything building a
    // hostile-target list should skip an entity with this set.
    this.isUntargetable = false;

    // Set true by Benedetta's Skill 2 (An Eye for an Eye) during her
    // parry stance - Combat.applyDamage/applySlow refuse to affect an
    // invulnerable entity. tookHitWhileInvulnerable is flipped on by
    // applyDamage the instant something tries (and fails) to hit her,
    // so the skill can react to "an attack was just blocked".
    this.isInvulnerable = false;
    this.isCrowdControlImmune = false;
    this.shield = 0;
    this.shieldTimeRemaining = 0;
    this.tookHitWhileInvulnerable = false;
    this.tookCrowdControlWhileInvulnerable = false;

    // Crowd-control lock - set by Combat.applyStun. Movement/attacks
    // are skipped below while true.
    this.isStunned = false;
    this.stunTimeRemaining = 0;

    // Slow/debuff state (e.g. from Gusion's Sword Waves). 1 = full speed.
    // Mirrors Enemy so both heroes are equally affected by slow effects.
    this.slowMultiplier = 1;
    this.slowTimeRemaining = 0;

    // Brief visual "punch" scale applied right after an attack lands.
    this.attackFlashTimer = 0;

    // Benedetta passive: the Energy Bar is filled by holding Attack or
    // by combat, then spent to unleash Elapsed Daytime's dash slash.
    this.energy = 0;
    this.maxEnergy = 90;
    this.energyChargeRate = 52; // full after just under two seconds held
    this.passiveChargeDelay = 180; // taps stay normal attacks, not micro-charges
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
    // Recent distinct enemies hit determine Benedetta's combat-charge
    // bonus. The window keeps one multi-target attack/combo together.
    this.passiveDamageTargets = new Set();
    this.passiveDamageTargetWindow = 0;
    this.passiveDamageTargetWindowDuration = 900;

    // Recall ability (B key) - channel to teleport back to base
    this.isRecalling = false;
    this.recallTimer = 0;
    this.recallDuration = 4000; // 5 seconds channel time

    // Sprite sheet + animator setup.
    this.sheetImage = new Image();
    this.sheetImage.src = spriteSrc;

    // Row layout must match the generated sprite sheet:
    // row 0 = down, row 1 = left, row 2 = right, row 3 = up
    const ROW_MAP = { down: 0, left: 1, right: 2, up: 3 };
    const FRAME_SIZE = 64;
    const FRAME_COUNT = 4;

    this.animator = new SpriteAnimator(
      this.sheetImage,
      FRAME_SIZE,
      FRAME_SIZE,
      ROW_MAP,
      FRAME_COUNT,
      110 // ms per frame - tweak for walk-cycle speed
    );
  }

  /**
   * Updates the player's position, animation, and combat state.
   * @param {number} deltaTime - ms since last frame
   * @param {number} gameTime - total game time in ms
   */
  update(deltaTime, gameTime) {
    // Update respawn delay based on game time
    // Increases by 3 seconds every 20 seconds, max 20 seconds
    const gameSeconds = gameTime / 1000;
    const additionalDelay = Math.floor(gameSeconds / 60) * 3000; // +3s per 20s
    this.respawnDelay = Math.min(this.baseRespawnDelay + additionalDelay, 20000); // Max 20s

    // Cooldown tracking
    if (this.cooldownRemaining > 0) {
      this.cooldownRemaining -= deltaTime;
    }

    if (this.passiveDamageTargetWindow > 0) {
      this.passiveDamageTargetWindow -= deltaTime;
      if (this.passiveDamageTargetWindow <= 0) {
        this.passiveDamageTargetWindow = 0;
        this.passiveDamageTargets.clear();
      }
    }

    Combat.tickStun(this, deltaTime);
    Combat.tickShield(this, deltaTime);
    Combat.tickSlow(this, deltaTime);

    if (this.attackFlashTimer > 0) {
      this.attackFlashTimer = Math.max(0, this.attackFlashTimer - deltaTime);
    }

    // Recall channeling
    if (this.isRecalling) {
      this.recallTimer -= deltaTime;
      if (this.recallTimer <= 0) {
        // Recall complete - teleport to base
        this._completeRecall();
      }
    }

    // Death / respawn handling
    if (this.hp <= 0 && !this.isDead) {
      this.isDead = true;
      this.respawnTimer = this.respawnDelay;
      this.deaths++; // Track death count
    }

    if (this.isDead) {
      this.respawnTimer -= deltaTime;
      this.isMoving = false;
      this.animator.update(deltaTime, this.direction, false);
      if (this.respawnTimer <= 0) {
        this._respawn();
      }
      return; // no movement/attacks while dead
    }

    if (this.isStunned || this.isMovementLocked) {
      this.isMoving = false;
      this.animator.update(deltaTime, this.direction, false);
      return; // no input movement while stunned or locked in a skill
    }

    const move = inputHandler.getMovementVector();
    this.isMoving = move.x !== 0 || move.y !== 0;

    // Cancel recall if player moves
    if (this.isRecalling && this.isMoving) {
      this._cancelRecall();
    }

    if (this.isMoving) {
      // Convert speed (px/sec) to this frame's distance using deltaTime.
      // slowMultiplier applies the same way it does for the enemy AI.
      const distance = this.speed * this.slowMultiplier * (deltaTime / 1000);
      this.x += move.x * distance;
      this.y += move.y * distance;

      // Determine facing direction. Horizontal movement takes
      // priority over vertical when moving diagonally so the
      // character faces the more "dominant" visual direction.
      if (Math.abs(move.x) > Math.abs(move.y)) {
        this.direction = move.x > 0 ? 'right' : 'left';
      } else if (move.y !== 0) {
        this.direction = move.y > 0 ? 'down' : 'up';
      }
    }

    // Keep the player fully inside the map at all times.
    const clamped = Collision.clampToMap(
      this.x,
      this.y,
      this.collisionWidth / 2,
      this.collisionHeight / 2,
      this.mapBounds
    );
    this.x = clamped.x;
    this.y = clamped.y;

    // Advance sprite animation based on current state.
    this.animator.update(deltaTime, this.direction, this.isMoving);
  }

  /**
   * Starts the recall channel to teleport back to base.
   * @returns {boolean} true if recall started successfully
   */
  startRecall() {
    if (this.isDead || this.isRecalling) {
      return false;
    }
    this.isRecalling = true;
    this.recallTimer = this.recallDuration;
    this.isMoving = false;
    return true;
  }

  /**
   * Completes the recall - teleports player to spawn point.
   */
  _completeRecall() {
    this.x = this.spawnX;
    this.y = this.spawnY;
    this.isRecalling = false;
    // Heal player on successful recall
    this.hp = this.maxHp;
  }

  /**
   * Cancels the recall channel.
   */
  _cancelRecall() {
    this.isRecalling = false;
    this.recallTimer = 0;
  }

  /**
   * Called when player takes damage - cancels recall if active.
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

    // Combat gain is 30% higher than before, with another 30% of the
    // base gain for every additional enemy hit in the current combo.
    const enemyMultiplier = 1 + Math.max(0, this.passiveDamageTargets.size - 1) * 0.3;
    this._gainEnergy(Math.max(6, amount * 0.45) * 3.8 * enemyMultiplier);
  }

  // A successful An Eye for an Eye block is the one incoming-hit
  // exception: it immediately fills Benedetta's passive bar.
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

  updateElapsedDaytime(deltaTime, held, released, hostiles, effects, onHitKill) {
    if (this.character !== 'benedetta') return;
    // Death immediately ends the passive; a corpse can neither finish a
    // charged dash nor deal its remaining path damage.
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
      // Only time held beyond this small threshold can charge energy.
      // This keeps rapid button taps from becoming free passive charge.
      const chargeTime = Math.max(0, this.passiveChargeHeldMs - this.passiveChargeDelay)
        - Math.max(0, heldBefore - this.passiveChargeDelay);
      this._gainEnergy(this.energyChargeRate * chargeTime / 1000);
      // A small gold pulse at her feet makes holding Charge readable.
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

  _startPassiveDash() {
    if (this.isDead) return;
    const move = inputHandler.getMovementVector();
    const fallback = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
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
   * Resets the player back to full health at their spawn point.
   * Called automatically once the respawn timer runs out.
   */
  _respawn() {
    this.hp = this.maxHp;
    this.x = this.spawnX;
    this.y = this.spawnY;
    this.isDead = false;
    this.cooldownRemaining = 0;
    this.isRecalling = false;
    this.recallTimer = 0;
    this.isUntargetable = false;
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
    this.isMovementLocked = false;
    this.energy = 0;
    this.isChargingPassive = false;
    this.isPassiveDashing = false;
    this.passiveChargeHeldMs = 0;
    this.passiveDamageTargets.clear();
    this.passiveDamageTargetWindow = 0;
  }

  /**
   * Attempts to attack a target entity (Creep or Tower - anything
   * with x, y, and hp). Fails silently (returns false) if the
   * attack is on cooldown, the player is dead, or the target is
   * out of range - game.js is expected to check the return value
   * if it wants to show feedback.
   *
   * @param {{x:number, y:number, hp:number}} target
   * @param {EffectSystem} effects
   * @returns {boolean} true if the attack landed
   */
  tryAttack(target, effects) {
    if (this.isDead || this.isRecalling || this.cooldownRemaining > 0) return false;
    if (!Combat.inRange(this.x, this.y, target.x, target.y, this.attackRange)) return false;

    Combat.applyDamage(target, this.attackDamage, this);
    effects.spawnAttackEffect(this.x, this.y, target.x, target.y, '#fff176');
    this.cooldownRemaining = this.attackCooldown;
    this.attackFlashTimer = 120;
    this._faceToward(target.x, target.y);
    return true;
  }

  /**
   * Faces the player toward a world point, matching the same
   * direction convention used by movement (down/left/right/up).
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
   * Draws the player at its correct SCREEN position (already
   * converted from world space by the camera in game.js).
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} screenX
   * @param {number} screenY
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
    // Attack range indicator - a soft dashed ring showing exactly how
    // close a target needs to be for a click to land as an attack.
    if (!this.isDead) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 241, 118, 0.55)';
      ctx.setLineDash([6, 6]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(screenX, screenY, this.attackRange, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Slow indicator - a puddle beneath the feet, matching the enemy AI.
    if (!this.isDead && this.slowTimeRemaining > 0) {
      Combat.drawSlowIndicator(ctx, screenX, screenY + this.drawHeight / 2 - 6);
    }

    // Stun indicator - shown above the head while crowd-controlled.
    if (this.isStunned) {
      Combat.drawStunIndicator(ctx, screenX, screenY - this.drawHeight / 2 - 24);
    }

    // Recall channeling indicator - circular progress ring
    if (this.isRecalling) {
      ctx.save();
      const progress = 1 - (this.recallTimer / this.recallDuration);
      const radius = 45;
      
      // Background ring
      ctx.strokeStyle = 'rgba(129, 212, 250, 0.3)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(screenX, screenY, radius, 0, Math.PI * 2);
      ctx.stroke();
      
      // Progress arc
      ctx.strokeStyle = '#81d4fa';
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(screenX, screenY, radius, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * progress));
      ctx.stroke();
      
      // Recall text
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(
        `Recalling ${Math.ceil(this.recallTimer / 1000)}s`,
        screenX,
        screenY - 55
      );
      ctx.restore();
    }

    // Soft shadow beneath the player for a bit of visual depth.
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.beginPath();
    ctx.ellipse(screenX, screenY + 20, 16, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    if (this.isDead) {
      // Faded/grayed out while waiting to respawn.
      ctx.globalAlpha = 0.35;
    }

    // A quick outward "punch" scale right after landing an attack,
    // giving hits some weight without needing extra sprite frames.
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

    // Health bar above the player's head (skipped while dead so the
    // faded sprite alone communicates the respawn state).
    if (!this.isDead) {
      Combat.drawHealthBar(ctx, screenX, screenY - this.drawHeight / 2 - 10, 46, this.hp, this.maxHp, '#4CAF50', this.shield);
    } else {
      // Respawn countdown text instead of a health bar.
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
