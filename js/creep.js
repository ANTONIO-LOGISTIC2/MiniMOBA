/**
 * creep.js
 * ------------------------------------------------------
 * Creeps are simple lane minions that belong to a faction
 * ('player' or 'enemy'):
 *  - Walk along a fixed path (array of waypoints) toward their
 *    destination.
 *  - If a HOSTILE unit (opposing creeps, the opposing tower, or
 *    the human player, depending on faction) gets close enough,
 *    they stop and fight instead of continuing to walk.
 *  - Have HP and can be killed.
 *  - If they reach the end of the path alive, they despawn
 *    (simulating "reaching the base").
 *
 * Wave spawning is handled by CreepSpawner at the bottom of this
 * file, keeping "who creates creeps and when" separate from
 * "how a single creep behaves".
 * ------------------------------------------------------
 */

class Creep {
  // Used by the constructor to hand out a stable id per instance
  // (see the `id` field below) - a plain incrementing counter is fine
  // since creeps are only ever compared for equality within a single
  // browser tab's lifetime.
  static _nextId = 1;

  /**
   * @param {Array<{x:number,y:number}>} path - waypoints to walk through, in order
   * @param {string} faction - 'player' or 'enemy'. Determines sprite, health-bar
   *        color, and (via game.js) which units count as hostile to this creep.
   * @param {number} [scalingMultiplier] - stat multiplier based on game time (1.0 = base stats)
   */
  constructor(path, faction = 'enemy', scalingMultiplier = 1.0) {
    this.path = path;
    this.pathIndex = 0;
    this.x = path[0].x;
    this.y = path[0].y;
    this.faction = faction;

    // Stable per-creep id, used by game.js to let the PVP guest's
    // browser match network snapshots back to persistent puppets (so
    // each creep's walk-cycle animation stays smooth instead of
    // restarting on every state broadcast) - not used anywhere in the
    // simulation itself.
    this.id = Creep._nextId++;

    // Stats - scaled by game time (10% increase every 3 minutes)
    const baseMaxHp = 60;
    const baseAttackDamage = 5;
    this.maxHp = Math.floor(baseMaxHp * scalingMultiplier);
    this.hp = this.maxHp;
    this.speed = 70; // px/sec, slower than the player
    this.attackDamage = Math.floor(baseAttackDamage * scalingMultiplier);
    this.attackRange = 45;
    this.attackCooldown = 1000; // ms
    this.cooldownRemaining = 0;
    this.aggroRange = 140; // how close a hostile unit must be to trigger a fight

    // Slow/debuff state (e.g. from Gusion's Sword Waves). 1 = full speed.
    this.slowMultiplier = 1;
    this.slowTimeRemaining = 0;

    // Crowd-control lock (e.g. from Benedetta's parry dash).
    this.isStunned = false;
    this.stunTimeRemaining = 0;

    // Visuals
    this.drawWidth = 48;
    this.drawHeight = 48;
    this.direction = 'down';
    this.isMoving = false;
    this.reachedEnd = false;

    // Sticky target lock - once acquired, kept until it dies or flees
    // out of aggroRange, rather than re-picking "the nearest hostile"
    // every frame (which caused visible target-flickering whenever a
    // second unit got marginally closer mid-fight).
    this.currentTarget = null;

    // Player-faction creeps reuse the blue player sprite sheet,
    // enemy-faction creeps reuse the red enemy sprite sheet - an
    // easy, asset-free way to make the two sides read clearly.
    // All creeps on a faction use the same sheet. Creating a new Image for
    // every spawn causes needless allocations and decoding work once combat
    // has been running for a while.
    this.sheetImage = Creep.getSpriteSheet(faction);
    this.barColor = faction === 'player' ? '#42a5f5' : '#ef5350';

    const ROW_MAP = { down: 0, left: 1, right: 2, up: 3 };
    this.animator = new SpriteAnimator(this.sheetImage, 64, 64, ROW_MAP, 4, 150);
  }

  /**
   * Updates movement/combat state for one frame.
   * @param {number} deltaTime - ms since last frame
   * @param {Array<{x:number,y:number,hp:number}>} hostiles - every unit this
   *        creep is allowed to fight (built by game.js based on faction)
   * @param {EffectSystem} effects - used to spawn attack visuals
   */
  update(deltaTime, hostiles, effects) {
    if (this.hp <= 0) return;

    Combat.tickSlow(this, deltaTime);
    Combat.tickStun(this, deltaTime);

    if (this.isStunned) {
      this.isMoving = false;
      this.animator.update(deltaTime, this.direction, false);
      return; // no movement/attacks while stunned
    }

    if (this.cooldownRemaining > 0) {
      this.cooldownRemaining -= deltaTime;
    }

    // Keep fighting whatever we already locked onto rather than
    // re-evaluating "who's nearest" every frame - only look for a new
    // target once the current one is dead or has fled out of range.
    if (this.currentTarget && this.currentTarget.hp <= 0) {
      this.currentTarget = null;
    }
    if (this.currentTarget) {
      const distToCurrent = Combat.distance(this.x, this.y, this.currentTarget.x, this.currentTarget.y);
      if (distToCurrent > this.aggroRange) {
        this.currentTarget = null; // let it go rather than chasing forever
      }
    }
    if (!this.currentTarget) {
      const { target: nearest, dist: nearestDist } = this._findNearestHostile(hostiles);
      this.currentTarget = (nearest && nearestDist <= this.aggroRange) ? nearest : null;
    }

    const target = this.currentTarget;
    const dist = target ? Combat.distance(this.x, this.y, target.x, target.y) : Infinity;

    if (target && dist <= this.aggroRange) {
      this._faceToward(target.x, target.y);

      if (dist <= this.attackRange) {
        // Close enough to swing: stop moving and attack on cooldown.
        this.isMoving = false;
        if (this.cooldownRemaining <= 0) {
          Combat.applyDamage(target, this.attackDamage);
          const color = this.faction === 'player' ? '#64b5f6' : '#ff8a65';
          effects.spawnAttackEffect(this.x, this.y, target.x, target.y, color);
          this.cooldownRemaining = this.attackCooldown;
        }
      } else if (dist > this.attackRange) {
        // Spotted a target but it's still out of swing range: chase it
        // down instead of standing still (otherwise two creeps that
        // detect each other right at the edge of aggroRange would
        // freeze forever without ever actually fighting).
        this._moveToward(target.x, target.y, deltaTime);
        this.isMoving = true;
      }
    } else {
      // No hostile nearby: keep walking along the path.
      this._followPath(deltaTime);
    }

    this.animator.update(deltaTime, this.direction, this.isMoving);
  }

  /**
   * Scans a list of potential targets and returns the closest one
   * that's still alive, along with the distance to it.
   */
  _findNearestHostile(hostiles) {
    let target = null;
    let nearestDist = Infinity;
    for (const h of hostiles) {
      if (!h || h.hp <= 0) continue;
      const d = Combat.distance(this.x, this.y, h.x, h.y);
      if (d < nearestDist) {
        target = h;
        nearestDist = d;
      }
    }
    return { target, dist: nearestDist };
  }

  /**
   * Moves the creep toward its current waypoint, advancing to
   * the next one when reached. Marks reachedEnd once the final
   * waypoint is hit.
   */
  _followPath(deltaTime) {
    if (this.pathIndex >= this.path.length - 1) {
      this.reachedEnd = true;
      this.isMoving = false;
      return;
    }

    const target = this.path[this.pathIndex + 1];
    const dist = Combat.distance(this.x, this.y, target.x, target.y);
    const step = this.speed * this.slowMultiplier * (deltaTime / 1000);

    if (dist <= step) {
      // Snap to the waypoint and advance.
      this.x = target.x;
      this.y = target.y;
      this.pathIndex++;
    } else {
      const dx = (target.x - this.x) / dist;
      const dy = (target.y - this.y) / dist;
      this.x += dx * step;
      this.y += dy * step;
      this._faceToward(target.x, target.y);
    }

    this.isMoving = true;
  }

  /**
   * Moves the creep directly toward a target point (used when chasing
   * a hostile unit instead of following the lane path).
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
  }

  /**
   * Sets this.direction based on the dominant axis toward (tx, ty),
   * matching the same left/right/up/down row convention as Player.
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
   * Draws the creep and its health bar. Call only when on-screen
   * (game.js can skip off-screen entities for performance, though
   * Phase 2's creep counts are small enough it isn't required).
   */
  draw(ctx, screenX, screenY) {
    screenY -= Combat.getAirborneLift(this);
    if (this.slowTimeRemaining > 0) {
      Combat.drawSlowIndicator(ctx, screenX, screenY + this.drawHeight / 2 - 6);
    }
    if (this.isStunned) {
      Combat.drawStunIndicator(ctx, screenX, screenY - this.drawHeight / 2 - 14);
    }
    if (this.sheetImage.complete) {
      this.animator.draw(ctx, screenX, screenY, this.drawWidth, this.drawHeight);
    }
    Combat.drawHealthBar(ctx, screenX, screenY - this.drawHeight / 2 - 4, 40, this.hp, this.maxHp, this.barColor);
  }

  static getSpriteSheet(faction) {
    const cacheKey = faction === 'player' ? 'playerSheet' : 'enemySheet';
    if (!Creep[cacheKey]) {
      const image = new Image();
      image.src = faction === 'player'
        ? 'assets/player/player_spritesheet.png'
        : 'assets/enemy/enemy_spritesheet.png';
      Creep[cacheKey] = image;
    }
    return Creep[cacheKey];
  }
}

/**
 * CreepSpawner
 * ------------------------------------------------------
 * Spawns waves of same-faction creeps at a fixed interval along
 * a shared path. game.js only needs to call update() every frame
 * (passing in that faction's list of hostile targets) and read
 * .creeps for the current live list.
 * ------------------------------------------------------
 */
class CreepSpawner {
  /**
   * @param {Array<{x:number,y:number}>} path - lane waypoints, walked start-to-end
   * @param {string} faction - 'player' or 'enemy'
   * @param {number} waveInterval - ms between waves
   * @param {number} creepsPerWave - how many creeps spawn per wave
   */
  constructor(path, faction = 'enemy', waveInterval = 8000, creepsPerWave = 3) {
    this.path = path;
    this.faction = faction;
    this.waveInterval = waveInterval;
    this.creepsPerWave = creepsPerWave;
    this.timeSinceLastWave = waveInterval; // spawn the first wave immediately
    this.spawnStagger = 400; // ms between individual creeps within a wave
    this.pendingSpawns = 0;
    this.staggerTimer = 0;
    // A safety limit prevents unbounded entity growth if a lane is blocked
    // or a future game mode lets creeps survive indefinitely.
    this.maxActiveCreeps = 18;

    this.creeps = [];
  }

  /**
   * Calculates the stat scaling multiplier based on game time.
   * Creeps get 10% stronger every 3 minutes.
   * @param {number} gameTimeMs - total game time in milliseconds
   * @returns {number} multiplier (1.0 = base stats)
   */
  _calculateScalingMultiplier(gameTimeMs) {
    const gameTimeMinutes = gameTimeMs / 60000; // Convert to minutes
    const scalingSteps = Math.floor(gameTimeMinutes / 3); // How many 3-minute intervals have passed
    return 1.0 + (scalingSteps * 0.1); // 10% increase per 3-minute interval
  }

  /**
   * Advances wave timing, spawns new creeps as needed, updates
   * all living creeps against the given hostiles list, and clears
   * out dead/finished ones.
   * @param {number} deltaTime
   * @param {Array} hostiles - units this wave's creeps may fight
   * @param {EffectSystem} effects
   * @param {number} gameTime - total game time in ms for creep scaling
   */
  update(deltaTime, hostiles, effects, gameTime = 0) {
    // ---- Wave timing ----
    this.timeSinceLastWave += deltaTime;
    if (this.timeSinceLastWave >= this.waveInterval) {
      this.timeSinceLastWave = 0;
      this.pendingSpawns = this.creepsPerWave;
      this.staggerTimer = 0;
    }

    // ---- Staggered spawning within a wave (so creeps don't overlap exactly) ----
    if (this.pendingSpawns > 0 && this.creeps.length < this.maxActiveCreeps) {
      this.staggerTimer -= deltaTime;
      if (this.staggerTimer <= 0) {
        const scalingMultiplier = this._calculateScalingMultiplier(gameTime);
        this.creeps.push(new Creep(this.path, this.faction, scalingMultiplier));
        this.pendingSpawns--;
        this.staggerTimer = this.spawnStagger;
      }
    }

    // ---- Update living creeps ----
    for (const creep of this.creeps) {
      creep.update(deltaTime, hostiles, effects);
    }

    // ---- Remove dead or finished creeps ----
    this.creeps = this.creeps.filter(c => c.hp > 0 && !c.reachedEnd);
  }

  draw(ctx, camera) {
    for (const creep of this.creeps) {
      const sx = camera.worldToScreenX(creep.x);
      const sy = camera.worldToScreenY(creep.y);
      creep.draw(ctx, sx, sy);
    }
  }
}
