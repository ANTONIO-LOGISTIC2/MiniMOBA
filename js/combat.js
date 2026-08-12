/**
 * combat.js
 * ------------------------------------------------------
 * Shared combat utilities used by Player, Creep, and Tower.
 * Centralizing this logic here avoids duplicating attack-range
 * checks, damage application, or health-bar drawing in every
 * entity file.
 *
 * Also owns a small "attack effects" system: short-lived
 * visuals (a line + impact flash) spawned whenever something
 * lands a hit, purely cosmetic and self-cleaning.
 * ------------------------------------------------------
 */

const Combat = {
  /**
   * Distance helper (world-space).
   */
  distance(ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    return Math.sqrt(dx * dx + dy * dy);
  },

  /**
   * Returns true if target is within `range` of the attacker.
   */
  inRange(attackerX, attackerY, targetX, targetY, range) {
    return this.distance(attackerX, attackerY, targetX, targetY) <= range;
  },

  /**
   * Applies damage to any entity that exposes { hp } and clamps
   * it at 0 so health bars never show a negative value.
   * Returns true if this hit killed the entity.
   *
   * Entities with `isInvulnerable` set (e.g. Benedetta mid-parry)
   * take no damage. Blocked damage can still grant a passive resource,
   * but it is deliberately separate from a blocked crowd-control event.
   */
  applyDamage(entity, amount, source = null) {
    const attacker = source || this.activeSource || null;
    if (entity.isInvulnerable) {
      entity.tookHitWhileInvulnerable = true;
      if (typeof entity.onBlockedDamage === 'function') entity.onBlockedDamage(amount, attacker);
      return false;
    }
    const originalAmount = amount;
    if (entity.shield > 0) {
      const absorbed = Math.min(entity.shield, amount);
      entity.shield -= absorbed;
      amount -= absorbed;
      if (entity.shield <= 0) entity.shield = 0;
    }
    if (typeof this.onDamageApplied === 'function') this.onDamageApplied(entity, attacker);
    // Call onDamageTaken if the entity has it (for recall cancellation)
    if (typeof entity.onDamageTaken === 'function') {
      entity.onDamageTaken(originalAmount);
    }
    if (attacker && typeof attacker.onDamageDealt === 'function') attacker.onDamageDealt(amount, entity);
    if (amount <= 0) return false;
    entity.hp = Math.max(0, entity.hp - amount);
    return entity.hp === 0;
  },

  /**
   * Draws a small health bar centered above an entity.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} screenX - center x on screen
   * @param {number} screenY - top of the entity on screen (bar is drawn above this)
   * @param {number} width
   * @param {number} currentHp
   * @param {number} maxHp
   * @param {string} fillColor - bar color when healthy
   */
  drawHealthBar(ctx, screenX, screenY, width, currentHp, maxHp, fillColor = '#4CAF50', shield = 0) {
    const height = 6;
    const x = screenX - width / 2;
    const y = screenY;
    const pct = Math.max(0, currentHp / maxHp);

    ctx.save();
    // Background (empty portion)
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x, y, width, height);

    // Filled portion - shifts toward red as health drops.
    ctx.fillStyle = pct > 0.5 ? fillColor : (pct > 0.2 ? '#e0a800' : '#d9534f');
    ctx.fillRect(x, y, width * pct, height);

    // Shields sit visibly on top of HP as a white segment.
    if (shield > 0) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.fillRect(x, y, width * Math.min(1, shield / maxHp), height);
    }

    // Border
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, width, height);
    ctx.restore();
  }
};

// ---- Slow / debuff helpers ----
// Kept as separate assignments (rather than crammed into the object
// literal above) purely so this section reads as its own unit; they
// still live on the same shared Combat object.

/**
 * Applies a temporary movement-speed debuff to any entity that
 * exposes a `speed` property. The entity itself is responsible
 * for multiplying its own speed by `slowMultiplier` and for
 * calling tickSlow() every frame to count the duration down.
 * @param {Object} entity
 * @param {number} multiplier - e.g. 0.5 for a 50% slow
 * @param {number} duration - ms the slow lasts
 */
Combat.applySlow = function (entity, multiplier, duration) {
  if (entity.isInvulnerable || entity.isCrowdControlImmune) return;
  entity.slowMultiplier = multiplier;
  entity.slowTimeRemaining = duration;
};

/**
 * Counts down an entity's active slow and clears it once it
 * expires. Safe to call every frame even if the entity was
 * never slowed (slowTimeRemaining defaults to 0/undefined).
 * @param {Object} entity
 * @param {number} deltaTime - ms since last frame
 */
Combat.tickSlow = function (entity, deltaTime) {
  if (entity.slowTimeRemaining > 0) {
    entity.slowTimeRemaining -= deltaTime;
    if (entity.slowTimeRemaining <= 0) {
      entity.slowTimeRemaining = 0;
      entity.slowMultiplier = 1;
    }
  }
};

/**
 * Applies a stun (a full crowd-control lock - the entity itself is
 * responsible for skipping its own movement/attacks/actions while
 * `isStunned` is true, and for calling tickStun() every frame to
 * count the duration down). Refuses to apply to an invulnerable
 * entity, same as applySlow.
 * @param {Object} entity
 * @param {number} duration - ms the stun lasts
 */
Combat.applyStun = function (entity, duration) {
  if (entity.isInvulnerable || entity.isCrowdControlImmune) {
    entity.tookCrowdControlWhileInvulnerable = true;
    return;
  }
  entity.isStunned = true;
  entity.stunTimeRemaining = Math.max(entity.stunTimeRemaining || 0, duration);
};

/**
 * Applies an airborne knock-up. It uses the normal stun lock for the
 * gameplay effect while preserving a distinct state for skills and UI
 * effects that need to identify a knock-up rather than an ordinary stun.
 */
Combat.applyAirborne = function (entity, duration) {
  if (entity.isInvulnerable || entity.isCrowdControlImmune) {
    // If immune to crowd control, do not apply any CC effects at all
    entity.tookCrowdControlWhileInvulnerable = true;
    return;
  }
  Combat.applyStun(entity, duration);
  entity.isAirborne = true;
  entity.airborneDuration = Math.max(entity.airborneDuration || 0, duration);
  entity.airborneTimeRemaining = Math.max(entity.airborneTimeRemaining || 0, duration);
};

/**
 * Counts down an entity's active stun and clears it once it
 * expires. Safe to call every frame even if the entity was never
 * stunned (stunTimeRemaining defaults to 0/undefined).
 * @param {Object} entity
 * @param {number} deltaTime - ms since last frame
 */
Combat.tickStun = function (entity, deltaTime) {
  if (entity.airborneTimeRemaining > 0) {
    entity.airborneTimeRemaining -= deltaTime;
    if (entity.airborneTimeRemaining <= 0) {
      entity.airborneTimeRemaining = 0;
      entity.airborneDuration = 0;
      entity.isAirborne = false;
    }
  }
  if (entity.stunTimeRemaining > 0) {
    entity.stunTimeRemaining -= deltaTime;
    if (entity.stunTimeRemaining <= 0) {
      entity.stunTimeRemaining = 0;
      entity.isStunned = false;
      entity.isAirborne = false;
    }
  }
};

/** Returns the visual lift height for an active airborne knock-up. */
Combat.getAirborneLift = function (entity) {
  if (!entity.isAirborne || !entity.airborneDuration) return 0;
  const progress = 1 - Math.max(0, entity.airborneTimeRemaining) / entity.airborneDuration;
  return Math.sin(progress * Math.PI) * 38;
};

/** Gives an entity a temporary damage shield. */
Combat.grantShield = function (entity, amount, duration) {
  entity.shield = Math.max(entity.shield || 0, amount);
  entity.shieldTimeRemaining = Math.max(entity.shieldTimeRemaining || 0, duration);
};

/** Advances a temporary shield timer. */
Combat.tickShield = function (entity, deltaTime) {
  if (entity.shieldTimeRemaining > 0) {
    entity.shieldTimeRemaining -= deltaTime;
    if (entity.shieldTimeRemaining <= 0) {
      entity.shieldTimeRemaining = 0;
      entity.shield = 0;
    }
  }
};

/**
 * Draws a small spinning-stars icon above a stunned entity's head,
 * so the CC is visible at a glance without extra UI.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} screenX
 * @param {number} screenY - just above the entity's head
 */
Combat.drawStunIndicator = function (ctx, screenX, screenY) {
  ctx.save();
  ctx.fillStyle = '#ffd54f';
  ctx.font = 'bold 15px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('\u2726 \u2726', screenX, screenY);
  ctx.restore();
};

/**
 * Draws a small icy-blue puddle beneath a slowed entity's feet,
 * so the debuff is visible at a glance without extra UI.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} screenX
 * @param {number} screenY - the entity's feet/shadow position
 */
Combat.drawSlowIndicator = function (ctx, screenX, screenY) {
  ctx.save();
  ctx.fillStyle = 'rgba(79, 195, 247, 0.35)';
  ctx.beginPath();
  ctx.ellipse(screenX, screenY, 18, 7, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
};

/**
 * EffectSystem
 * ------------------------------------------------------
 * Manages short-lived cosmetic attack effects (a streak from
 * attacker to target, plus an impact burst) so combat has
 * visual feedback even without dedicated attack sprite frames.
 * ------------------------------------------------------
 */
class EffectSystem {
  constructor() {
    this.effects = []; // each: { fromX, fromY, toX, toY, life, maxLife, color }
    // Effects are cosmetic.  Keep a hard upper bound so a crowded lane
    // can never turn a burst of attacks into an ever-growing render list.
    this.maxEffects = 80;
    // Every effect spawned is also queued here, completely separate
    // from `effects` above (whose own capacity/expiry logic stays
    // untouched) - lets a PVP host relay just the newly-spawned
    // effects to the guest each state tick via drainRecentSpawns(),
    // instead of the guest never seeing attack effects at all.
    this._recentSpawns = [];
  }

  /**
   * Spawns a new attack-line effect between two world-space points.
   */
  spawnAttackEffect(fromX, fromY, toX, toY, color = '#fff176') {
    if (this.effects.length >= this.maxEffects) {
      this.effects.shift();
    }
    this.effects.push({
      fromX, fromY, toX, toY,
      life: 150,      // ms remaining
      maxLife: 150,
      color
    });
    this._recentSpawns.push({ fromX, fromY, toX, toY, color });
  }

  /**
   * PVP host only: returns every effect spawned since the last call to
   * this method, then clears the queue. game.js calls this once per
   * state broadcast so the guest's own local EffectSystem can spawn
   * (and independently fade) the same effects, rather than shipping
   * the whole constantly-expiring render list every tick.
   */
  drainRecentSpawns() {
    if (this._recentSpawns.length === 0) return this._recentSpawns;
    const spawns = this._recentSpawns;
    this._recentSpawns = [];
    return spawns;
  }

  /**
   * Advances all effects and removes any that have expired.
   * @param {number} deltaTime - ms since last frame
   */
  update(deltaTime) {
    for (const fx of this.effects) {
      fx.life -= deltaTime;
    }
    this.effects = this.effects.filter(fx => fx.life > 0);
  }

  /**
   * Draws all active effects. `camera` is used to convert the
   * stored world-space coordinates into screen-space.
   */
  draw(ctx, camera) {
    for (const fx of this.effects) {
      const alpha = Math.max(0, fx.life / fx.maxLife);
      const fx1 = camera.worldToScreenX(fx.fromX);
      const fy1 = camera.worldToScreenY(fx.fromY);
      const fx2 = camera.worldToScreenX(fx.toX);
      const fy2 = camera.worldToScreenY(fx.toY);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = fx.color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(fx1, fy1);
      ctx.lineTo(fx2, fy2);
      ctx.stroke();

      // Impact burst at the target end.
      ctx.fillStyle = fx.color;
      ctx.beginPath();
      ctx.arc(fx2, fy2, 6 * alpha + 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
}
