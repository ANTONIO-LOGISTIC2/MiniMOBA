/**
 * skill.js
 * ------------------------------------------------------
 * The player's ability system: 3 skill slots bound to the 1/2/3
 * keys, all implemented.
 *
 * Contains:
 *  - Projectile: a generic traveling bolt (movement, hostile
 *    collision/damage, glowing trail). Used directly by Skill 1,
 *    and extended by Skill 2's blades so they share the same look.
 *  - BladeThrowSkill (Skill 1): a two-phase ability -
 *      Phase 1 - throw a blade in the direction you're facing.
 *      Phase 2 - if it hits an enemy, a short recast window opens;
 *                pressing 1 again dashes you straight to that
 *                enemy and strikes them again.
 *      If phase 1 misses, or the recast window expires, the skill
 *      just goes on cooldown like a normal ability.
 *  - PhantomSlashSkill (Skill 1, Benedetta only): "Two Slashes" -
 *      a single-press, no-recast combo. On cast she instantly hits a
 *      wide hand-fan cone in front of her while hopping a short
 *      distance backward, then instantly hits a narrow straight line
 *      in front of that same spot while dashing forward back to where
 *      she started. Both hits are separate instant area checks off
 *      the same cast-time anchor/facing, so a target caught in both
 *      areas takes damage from each. SkillManager picks this over
 *      BladeThrowSkill when the caster is Benedetta.
 *  - ShurikenBlade / PhantomShurikenSkill (Skill 1, Hayabusa only):
 *      a single-cast alternative to Blade Throw - one press throws
 *      all 3 shuriken in a fan at once, they pierce out to max range,
 *      then automatically boomerang back to the caster with no
 *      recast needed. SkillManager picks this over BladeThrowSkill
 *      when the caster is Hayabusa.
 *  - ShadowClone / QuadShadowSkill (Skill 2, Hayabusa only): cast
 *      dashes forward and launches 4 shadows outward (forward, left,
 *      right, back); each stops at max range and lingers 4s, damaging/
 *      slowing/marking the first enemy it touches. Any press while
 *      shadows are out teleports the caster to the marked shadow (or
 *      the nearest one), with bonus damage if it's attached to an
 *      enemy - repeatable as long as shadows remain. SkillManager
 *      picks this over SwordWavesSkill when the caster is Hayabusa.
 *  - SwordWaveBlade / SwordWavesSkill (Skill 2): also two-phase -
 *      Phase 1 - throw 5 blades in a fan, piercing every hostile
 *                they pass through as they fly out to max range.
 *      Phase 2 - within a short window, recast to call the blades
 *                back to wherever you currently are, piercing
 *                everything on the way home too.
 *      If you don't recast in time, the blades are lost and the
 *      skill goes on cooldown.
 *  - UltimateSkill (Skill 3, "Blade Dance"): also two-phase, but
 *    deals no damage -
 *      Phase 1 - short-range teleport, and instantly resets Skill
 *                1 and Skill 2's cooldowns. If Skill 2's blades are
 *                still out (holding at range, or even mid-flight),
 *                they're kept alive rather than lost - see
 *                SwordWavesSkill.reset(). This is what enables the
 *                Gusion-style 10-blade combo: throw Skill 2, cast
 *                the ultimate, throw Skill 2 again while the first
 *                5 blades are still out, then recast Skill 2 once
 *                more to call all 10 blades home together.
 *      Phase 2 - within a short window, recast for a short follow-up
 *                dash (pure repositioning, no damage).
 *  - AlectoFinalBlowSkill (Skill 3, Benedetta only): winds up before
 *    a long untargetable dash that cuts through enemies, then leaves
 *    a damaging, slowing sword trail behind.
 *  - ShadowKillSkill (Skill 3, "Shadow Kill", Hayabusa only): a
 *    single-activation ultimate - finds every valid target within
 *    range (enemy heroes if any are in range, minions/jungle monsters
 *    only as a fallback), instantly dashes to the nearest one and
 *    goes untargetable, then unloads a burst of fast slashes spread
 *    across the whole target pool (all of them on one target if
 *    that's all that's in range), before dashing back to wherever
 *    the caster was standing when the ultimate was activated.
 *    SkillManager picks this over UltimateSkill when the caster is
 *    Hayabusa.
 *  - LockedSkill: an inert placeholder - currently unused, since
 *    all 3 slots are filled, but kept around for any future slot.
 *  - SkillManager: owns all 3 slots, routes 1/2/3 input to the
 *    right one, and updates/draws them every frame.
 * ------------------------------------------------------
 */

// Maps the same facing-direction strings used by Player/Creep
// movement into a unit vector a projectile/dash can travel along.
const SKILL_DIRECTION_VECTORS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 }
};

class Projectile {
  /**
   * @param {number} x - starting world x (usually the caster's position)
   * @param {number} y - starting world y
   * @param {{x:number,y:number}} direction - unit vector to travel along
   * @param {number} damage
   * @param {number} speed - px/sec
   * @param {number} maxDistance - px the bolt can travel before fizzling out
   */
  constructor(x, y, direction, damage, speed = 600, maxDistance = 550) {
    this.x = x;
    this.y = y;
    this.dirX = direction.x;
    this.dirY = direction.y;
    this.damage = damage;
    this.speed = speed;
    this.maxDistance = maxDistance;
    this.traveled = 0;
    this.hitRadius = 14; // the bolt's own collision radius

    this.isAlive = true;
    // Whatever the bolt struck, if anything - set even if the hit
    // didn't kill, so a skill can react to "who got hit" and not
    // just "who died". Read this once isAlive becomes false.
    this.hitTarget = null;

    // Recent positions, used to draw a fading comet-tail behind the bolt.
    this.trail = [];
    this.maxTrailPoints = 6;
  }

  /**
   * Moves the bolt forward, checks it against every hostile target,
   * and applies damage + removes itself on the first hit (or once
   * it runs out of range). Reports a kill back via onHitKill so
   * game.js can update the score without this file needing to know
   * anything about the UI.
   * @param {number} deltaTime - ms since last frame
   * @param {Array<{x:number,y:number,hp:number,drawWidth?:number}>} hostiles
   * @param {EffectSystem} effects
   * @param {(target:Object) => void} onHitKill
   */
  update(deltaTime, hostiles, effects, onHitKill) {
    if (!this.isAlive) return;

    // Record where the bolt WAS before moving, for the trail effect.
    this.trail.push({ x: this.x, y: this.y });
    if (this.trail.length > this.maxTrailPoints) this.trail.shift();

    const step = this.speed * (deltaTime / 1000);
    this.x += this.dirX * step;
    this.y += this.dirY * step;
    this.traveled += step;

    if (this.traveled >= this.maxDistance) {
      this.isAlive = false;
      return;
    }

    // Stop at the first hostile the bolt touches (simple point-vs-circle
    // check using each target's own sprite size as its hit radius)
    for (const target of hostiles) {
      if (!target || target.hp <= 0) continue;
      const targetRadius = target.drawWidth ? target.drawWidth / 2 : 20;

      if (Combat.distance(this.x, this.y, target.x, target.y) <= this.hitRadius + targetRadius) {
        const killed = Combat.applyDamage(target, this.damage);
        effects.spawnAttackEffect(this.x, this.y, this.x, this.y, '#90caf9'); // impact burst
        this.hitTarget = target;
        if (killed && onHitKill) onHitKill(target);
        this.isAlive = false;
        break;
      }
    }
  }

  /**
   * Draws the fading trail and the glowing bolt itself.
   * @param {CanvasRenderingContext2D} ctx
   * @param {Camera} camera
   * @param {string} color - bolt color, so different skills can reuse this class
   */
  draw(ctx, camera, color = '#90caf9') {
    // Comet-tail: older points are smaller and more transparent.
    for (let i = 0; i < this.trail.length; i++) {
      const point = this.trail[i];
      const progress = (i + 1) / (this.trail.length + 1); // 0 (oldest) -> 1 (newest)
      const sx = camera.worldToScreenX(point.x);
      const sy = camera.worldToScreenY(point.y);

      ctx.save();
      ctx.globalAlpha = progress * 0.5;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(sx, sy, 5 * progress + 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // The bolt itself: a soft radial-gradient orb so it reads as a
    // thrown blade without needing a dedicated sprite sheet.
    const sx = camera.worldToScreenX(this.x);
    const sy = camera.worldToScreenY(this.y);

    ctx.save();
    const gradient = ctx.createRadialGradient(sx, sy, 0, sx, sy, 14);
    gradient.addColorStop(0, '#e3f2fd');
    gradient.addColorStop(0.5, color);
    gradient.addColorStop(1, 'rgba(144, 202, 249, 0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(sx, sy, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

/**
 * BladeThrowSkill (Skill slot 1)
 * ------------------------------------------------------
 * A 2-phase ability, state machine style:
 *
 *   idle --(cast)--> [blade flying] --(hits enemy)--> awaiting_recast --(cast)--> [dashing] --> idle (on cooldown)
 *                          |                                 |
 *                     (misses / expires)                (window expires)
 *                          v                                 v
 *                   idle (on cooldown)               idle (on cooldown)
 * ------------------------------------------------------
 */
class BladeThrowSkill {
  constructor() {
    this.slot = 1;
    this.name = 'Blade Throw';
    this.locked = false;
    this.recastLabel = 'DASH!';

    // Cooldown only starts once the ability has fully resolved
    // (a miss, a completed dash, or a recast window expiring).
    this.maxCooldown = 4500; // ms
    this.cooldownRemaining = 0;

    // Phase 1 (thrown blade) stats
    this.throwDamage = 21; // reduced by 30% (was 30)
    this.projectileSpeed = 845; // increased by 30% (was 650)
    this.projectileRange = 350; // reduced range - Skill 3 can refresh this quickly, so phase 1 no longer needs to reach as far
    this.activeProjectile = null;

    // Phase 2 (recast dash) stats
    this.dashDamage = 31; // reduced by 30% (was 45)
    this.dashDuration = 200; // ms, increased by 30% speed (was 180)
    this.recastWindow = 3000; // ms the player has to recast after a hit

    // 'idle' | 'awaiting_recast'
    this.phase = 'idle';
    this.recastTimer = 0;
    this.hitTarget = null; // who phase 1 struck, and who phase 2 will dash to

    // Dash animation state
    this.isDashing = false;
    this.dashTimer = 0;
    this.dashFromX = 0;
    this.dashFromY = 0;
    this.dashToX = 0;
    this.dashToY = 0;
  }

  /**
   * Only "ready to throw" when fully idle, off cooldown, and no
   * blade is currently in flight. (Being in the recast window is
   * a different, still-castable state - see tryCast.)
   */
  get isReady() {
    return this.phase === 'idle' && this.cooldownRemaining <= 0 && !this.activeProjectile && !this.isDashing;
  }

  get isCasting() {
    return this.isDashing;
  }

  /**
   * Attempts to cast. Behavior depends on the current phase:
   *  - awaiting_recast: triggers the phase-2 dash strike.
   *  - otherwise: throws phase-1's blade, if off cooldown.
   * @param {Player} caster
   * @param {EffectSystem} effects
   * @param {(target:Object) => void} onHitKill
   * @param {Array} hostiles - unused by this skill (phase 1 resolves its
   *        own hostiles during update() as the blade travels)
   * @returns {boolean} true if something actually happened
   */
  tryCast(caster, effects, onHitKill, hostiles) {
    if (caster.isDead) return false;

    if (this.phase === 'awaiting_recast') {
      this._executeDash(caster, effects, onHitKill);
      return true;
    }

    if (!this.isReady) return false;

    const direction = SKILL_DIRECTION_VECTORS[caster.direction] || SKILL_DIRECTION_VECTORS.down;
    this.activeProjectile = new Projectile(
      caster.x, caster.y, direction, this.throwDamage, this.projectileSpeed, this.projectileRange
    );
    effects.spawnAttackEffect(caster.x, caster.y, caster.x, caster.y, '#64b5f6');
    return true;
  }

  /**
   * Advances whichever sub-state is currently active: the flying
   * blade, the recast countdown, or the dash animation.
   * @param {number} deltaTime
   * @param {Array} hostiles
   * @param {EffectSystem} effects
   * @param {(target:Object) => void} onHitKill
   * @param {Player} caster - needed to move the player during the dash
   */
  update(deltaTime, hostiles, effects, onHitKill, caster) {
    if (this.cooldownRemaining > 0) {
      this.cooldownRemaining -= deltaTime;
    }

    // ---- Dash animation in progress: smoothly move the caster and
    // ignore everything else until it finishes. ----
    if (this.isDashing) {
      this.dashTimer += deltaTime;
      const t = Math.min(1, this.dashTimer / this.dashDuration);
      caster.x = this.dashFromX + (this.dashToX - this.dashFromX) * t;
      caster.y = this.dashFromY + (this.dashToY - this.dashFromY) * t;
      if (t >= 1) {
        this.isDashing = false;
      }
      return;
    }

    // ---- Phase 1: blade in flight ----
    if (this.activeProjectile) {
      this.activeProjectile.update(deltaTime, hostiles, effects, onHitKill);

      if (!this.activeProjectile.isAlive) {
        const hit = this.activeProjectile.hitTarget;
        this.activeProjectile = null;

        if (hit) {
          // Landed on someone: open the recast window instead of
          // starting the cooldown yet.
          this.phase = 'awaiting_recast';
          this.recastTimer = this.recastWindow;
          this.hitTarget = hit;
        } else {
          // Missed entirely: go straight to cooldown.
          this.cooldownRemaining = this.maxCooldown;
        }
      }
      return;
    }

    // ---- Phase 2 window: waiting for a recast ----
    if (this.phase === 'awaiting_recast') {
      this.recastTimer -= deltaTime;
      const targetStillValid = this.hitTarget && this.hitTarget.hp > 0;

      if (this.recastTimer <= 0 || !targetStillValid) {
        // Window expired (or the target died some other way): the
        // free dash is lost, and the skill goes on cooldown now.
        this.phase = 'idle';
        this.hitTarget = null;
        this.cooldownRemaining = this.maxCooldown;
      }
    }
  }

  /**
   * Executes the phase-2 dash: instantly relocates the caster to
   * the struck target over a short animation and strikes again.
   */
  _executeDash(caster, effects, onHitKill) {
    if (!this.hitTarget || this.hitTarget.hp <= 0) {
      // Safety net - shouldn't normally happen since update() already
      // clears the phase once the target becomes invalid.
      this.phase = 'idle';
      this.cooldownRemaining = this.maxCooldown;
      return;
    }

    this.dashFromX = caster.x;
    this.dashFromY = caster.y;
    this.dashToX = this.hitTarget.x;
    this.dashToY = this.hitTarget.y;
    this.isDashing = true;
    this.dashTimer = 0;

    // Face the dash direction, matching the same convention as movement.
    const dx = this.dashToX - this.dashFromX;
    const dy = this.dashToY - this.dashFromY;
    if (Math.abs(dx) > Math.abs(dy)) {
      caster.direction = dx > 0 ? 'right' : 'left';
    } else if (dy !== 0) {
      caster.direction = dy > 0 ? 'down' : 'up';
    }

    // The strike lands immediately; the dash animation is just the
    // visual travel toward the target.
    const killed = Combat.applyDamage(this.hitTarget, this.dashDamage);
    effects.spawnAttackEffect(this.dashFromX, this.dashFromY, this.dashToX, this.dashToY, '#1e88e5');
    if (killed && onHitKill) onHitKill(this.hitTarget);

    this.phase = 'idle';
    this.hitTarget = null;
    this.cooldownRemaining = this.maxCooldown;
  }

  draw(ctx, camera) {
    if (this.activeProjectile) {
      this.activeProjectile.draw(ctx, camera, '#64b5f6');
    }
  }

  /**
   * Fully returns this skill to a fresh, immediately-castable state:
   * clears the cooldown, discards any blade in flight, cancels a
   * held recast window, and stops any in-progress dash. Used by
   * the ultimate (Skill 3) so resetting Skill 1 actually means
   * "ready to throw again", not just "cooldown says zero" while
   * still stuck mid-recast. Unlike Sword Waves, there's nothing
   * visual left to preserve here by the time a throw resolves (the
   * blade itself is already gone the instant it lands, leaving only
   * an internal "marked target" bookkeeping value) so this always
   * returns null - nothing for the caller to keep tracking.
   * @returns {null}
   */
  reset() {
    this.phase = 'idle';
    this.cooldownRemaining = 0;
    this.activeProjectile = null;
    this.hitTarget = null;
    this.recastTimer = 0;
    this.isDashing = false;
    this.dashTimer = 0;
    return null;
  }
}

/**
 * PhantomSlashSkill (Skill slot 1, Benedetta only)
 * ------------------------------------------------------
 * "Phantom Slash - Two Slashes": a single-press, two-hit melee combo
 * with no recast involved (unlike Blade Throw) - both slashes fire
 * automatically back-to-back off one key press.
 *
 *   idle --(cast)--> [step back + wide fan slash] --> [dash forward + narrow line slash] --> idle (on cooldown)
 *
 * Both slashes are resolved as instant area hit-tests (not traveling
 * projectiles) anchored to wherever Benedetta was standing and facing
 * the moment the skill was cast:
 *  - Slash 1 fires the instant the skill is cast, hitting everything
 *    in a wide hand-fan-shaped cone in front of her, while she visibly
 *    hops a short distance backward.
 *  - Slash 2 fires the instant she finishes stepping back, hitting
 *    everything in a narrow straight-line sliver in front of that same
 *    spot, while she dashes forward through it back to her start point.
 * A target standing in both the fan and the line takes both hits.
 * Cooldown only starts once the forward dash animation finishes.
 * ------------------------------------------------------
 */
class PhantomSlashSkill {
  constructor() {
    this.slot = 1;
    this.name = 'Phantom Slash';
    this.locked = false;

    this.maxCooldown = 5000; // ms
    this.cooldownRemaining = 0;

    // Shared reach for both slashes - same range, different shape.
    this.range = 100;
    this.fanHalfAngle = Math.PI / 2;    // 90 degrees each side -> 180 degree fan (wider)
    this.lineHalfAngle = Math.PI / 24;  // 6 degrees each side -> very narrow straight line

    this.slash1Damage = 27; // wide fan slash - reduced by 40% (was 45)
    this.slash2Damage = 35; // straight-line slash - reduced by 40% (was 55)

    this.stepBackDistance = 55; // px, "very short" hop backward
    this.stepBackDuration = 190; // ms
    this.dashForwardDuration = 210; // ms

    // 'idle' | 'stepping_back' | 'dashing_forward'
    this.phase = 'idle';
    this.stepTimer = 0;
    this.dashTimer = 0;

    // Anchor point + facing captured at cast time - both slashes and
    // the whole animation are resolved relative to this, not to
    // wherever the caster happens to be drifting on a given frame.
    this.originX = 0;
    this.originY = 0;
    this.dirVec = SKILL_DIRECTION_VECTORS.down;
    this.stepBackX = 0;
    this.stepBackY = 0;

    // Fading afterimages left behind by the hop + dash, for a smooth
    // "phantom" trail look.
    this.afterimages = [];

    // Retained so reset() can release the movement lock if another
    // skill interrupts this animation.
    this._activeCaster = null;

    // Telegraph visuals for the two slash shapes - each is set the
    // instant its slash resolves, then fades out over fanEffectDuration.
    this.fanVisual = null;
    this.fanEffectTimer = 0;
    this.fanEffectDuration = 180;
    this.lineVisual = null;
    this.lineEffectTimer = 0;
    this.lineEffectDuration = 180;
  }

  get isReady() {
    return this.phase === 'idle' && this.cooldownRemaining <= 0;
  }

  get isCasting() {
    return this.phase !== 'idle';
  }

  /**
   * @param {Player} caster
   * @param {EffectSystem} effects
   * @param {(target:Object) => void} onHitKill
   * @param {Array} hostiles - valid targets, used immediately to
   *        resolve slash 1's hit-test.
   */
  tryCast(caster, effects, onHitKill, hostiles) {
    if (caster.isDead) return false;
    if (!this.isReady) return false;

    this.originX = caster.x;
    this.originY = caster.y;
    this.dirVec = SKILL_DIRECTION_VECTORS[caster.direction] || SKILL_DIRECTION_VECTORS.down;
    this.stepBackX = this.originX - this.dirVec.x * this.stepBackDistance;
    this.stepBackY = this.originY - this.dirVec.y * this.stepBackDistance;

    this.phase = 'stepping_back';
    this.stepTimer = 0;
    this._onHitKill = onHitKill;
    this._activeCaster = caster;
    caster.isMovementLocked = true;

    // Slash 1 lands immediately, at the moment of cast.
    this._resolveFanSlash(hostiles, effects, onHitKill);
    this._spawnAfterimage(this.originX, this.originY);

    return true;
  }

  /**
   * Advances the step-back, then the forward dash, resolving slash 2
   * the instant the step-back finishes and starting the cooldown the
   * instant the forward dash finishes.
   */
  update(deltaTime, hostiles, effects, onHitKill, caster) {
    if (this.cooldownRemaining > 0) {
      this.cooldownRemaining -= deltaTime;
    }

    if (this.fanEffectTimer > 0) this.fanEffectTimer -= deltaTime;
    if (this.lineEffectTimer > 0) this.lineEffectTimer -= deltaTime;
    for (const img of this.afterimages) img.life -= deltaTime;
    this.afterimages = this.afterimages.filter(img => img.life > 0);

    if (this.phase === 'stepping_back') {
      this.stepTimer += deltaTime;
      const t = Math.min(1, this.stepTimer / this.stepBackDuration);
      caster.x = this.originX + (this.stepBackX - this.originX) * t;
      caster.y = this.originY + (this.stepBackY - this.originY) * t;

      if (t >= 1) {
        this.phase = 'dashing_forward';
        this.dashTimer = 0;
        this._spawnAfterimage(this.stepBackX, this.stepBackY);
        // Slash 2 lands the instant the forward dash begins.
        this._resolveLineSlash(hostiles, effects, onHitKill || this._onHitKill);
      }
      return;
    }

    if (this.phase === 'dashing_forward') {
      this.dashTimer += deltaTime;
      const t = Math.min(1, this.dashTimer / this.dashForwardDuration);
      caster.x = this.stepBackX + (this.originX - this.stepBackX) * t;
      caster.y = this.stepBackY + (this.originY - this.stepBackY) * t;

      if (t >= 1) {
        caster.x = this.originX;
        caster.y = this.originY;
        this.phase = 'idle';
        this._onHitKill = null;
        caster.isMovementLocked = false;
        this._activeCaster = null;
        // The full animation is over - the cooldown starts now.
        this.cooldownRemaining = this.maxCooldown;
      }
      return;
    }
  }

  /**
   * Instant hit-test for the wide fan-shaped slash: every hostile
   * within range whose angle off the caster's facing direction (from
   * the cast-time anchor point) falls inside the fan's half-angle.
   */
  _resolveFanSlash(hostiles, effects, onHitKill) {
    this._hitTestArea(hostiles, this.fanHalfAngle, this.slash1Damage, effects, onHitKill, '#ff8a65');
    this.fanVisual = {
      x: this.originX, y: this.originY,
      angle: Math.atan2(this.dirVec.y, this.dirVec.x),
      halfAngle: this.fanHalfAngle, range: this.range
    };
    this.fanEffectTimer = this.fanEffectDuration;
  }

  /**
   * Instant hit-test for the narrow straight-line slash: same range
   * and anchor as the fan, but a much tighter half-angle so only
   * targets roughly directly in front get hit.
   */
  _resolveLineSlash(hostiles, effects, onHitKill) {
    this._hitTestArea(hostiles, this.lineHalfAngle, this.slash2Damage, effects, onHitKill, '#fff59d');
    this.lineVisual = {
      x: this.originX, y: this.originY,
      angle: Math.atan2(this.dirVec.y, this.dirVec.x),
      halfAngle: this.lineHalfAngle, range: this.range
    };
    this.lineEffectTimer = this.lineEffectDuration;
  }

  /**
   * Shared cone hit-test used by both slashes - only the half-angle,
   * damage, and effect color differ between the fan and the line.
   * Anchored to the cast-time origin/facing, not the caster's current
   * (mid-animation) position, so both slashes stay "in front of where
   * she started" regardless of the hop/dash happening underneath them.
   */
  _hitTestArea(hostiles, halfAngle, damage, effects, onHitKill, color) {
    for (const target of hostiles) {
      if (!target || target.hp <= 0) continue;

      const targetRadius = target.drawWidth ? target.drawWidth / 2 : 20;
      const dx = target.x - this.originX;
      const dy = target.y - this.originY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > this.range + targetRadius) continue;

      if (dist > 1) {
        const nx = dx / dist;
        const ny = dy / dist;
        const dot = Math.max(-1, Math.min(1, nx * this.dirVec.x + ny * this.dirVec.y));
        const angle = Math.acos(dot);
        if (angle > halfAngle) continue;
      }

      const killed = Combat.applyDamage(target, damage, this._activeCaster);
      effects.spawnAttackEffect(this.originX, this.originY, target.x, target.y, color);
      if (killed && onHitKill) onHitKill(target);
    }
  }

  _spawnAfterimage(x, y) {
    this.afterimages.push({ x, y, life: 200, maxLife: 200 });
  }

  /**
   * Draws the afterimage trail plus a fading wedge for whichever
   * slash shape(s) most recently landed - a wide fan for slash 1, a
   * thin sliver for slash 2 - so the attack area itself is visible,
   * not just the damage numbers.
   */
  draw(ctx, camera) {
    for (const img of this.afterimages) {
      const alpha = Math.max(0, img.life / img.maxLife) * 0.4;
      const sx = camera.worldToScreenX(img.x);
      const sy = camera.worldToScreenY(img.y);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#ce93d8';
      ctx.beginPath();
      ctx.ellipse(sx, sy, 16, 24, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    if (this.fanEffectTimer > 0 && this.fanVisual) {
      this._drawWedge(ctx, camera, this.fanVisual, this.fanEffectTimer / this.fanEffectDuration, '#ff8a65');
    }
    if (this.lineEffectTimer > 0 && this.lineVisual) {
      this._drawWedge(ctx, camera, this.lineVisual, this.lineEffectTimer / this.lineEffectDuration, '#fff59d');
    }
  }

  /**
   * Draws a single fading cone/wedge (used for both the wide fan and
   * the narrow line - they're the same shape, just different angles).
   * Now draws multiple arc lines to simulate a sword slash motion.
   */
  _drawWedge(ctx, camera, visual, alpha, color) {
    const sx = camera.worldToScreenX(visual.x);
    const sy = camera.worldToScreenY(visual.y);
    const range = visual.range;

    ctx.save();
    ctx.globalAlpha = Math.max(0, alpha) * 0.6;
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';

    // Draw multiple arc lines to simulate sword slash motion
    const arcCount = 5;
    for (let i = 0; i < arcCount; i++) {
      const progress = (i + 1) / arcCount;
      const currentRange = range * progress;
      const lineWidth = 3 + (1 - progress) * 4;
      
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.arc(sx, sy, currentRange, visual.angle - visual.halfAngle, visual.angle + visual.halfAngle);
      ctx.stroke();
    }

    // Add a bright center line for the main slash
    ctx.globalAlpha = Math.max(0, alpha) * 0.9;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.arc(sx, sy, range * 0.7, visual.angle - visual.halfAngle * 0.5, visual.angle + visual.halfAngle * 0.5);
    ctx.stroke();

    // Add spark particles at the edge of the slash
    ctx.globalAlpha = Math.max(0, alpha) * 0.8;
    ctx.fillStyle = '#ffffff';
    const sparkCount = 8;
    for (let i = 0; i < sparkCount; i++) {
      const angle = visual.angle - visual.halfAngle + (visual.halfAngle * 2 * i / (sparkCount - 1));
      const sparkX = sx + Math.cos(angle) * range;
      const sparkY = sy + Math.sin(angle) * range;
      const sparkSize = 2 + Math.random() * 3;
      
      ctx.beginPath();
      ctx.arc(sparkX, sparkY, sparkSize, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  /**
   * Fully returns this skill to a fresh, immediately-castable state.
   * Same purpose as BladeThrowSkill.reset() - used if a future
   * ultimate wants to refresh Skill 1 for Benedetta the same way
   * Blade Dance does for Gusion.
   * @returns {null}
   */
  reset() {
    if (this._activeCaster) {
      this._activeCaster.isMovementLocked = false;
    }
    this.phase = 'idle';
    this.cooldownRemaining = 0;
    this.stepTimer = 0;
    this.dashTimer = 0;
    this._onHitKill = null;
    this._activeCaster = null;
    this.afterimages = [];
    this.fanVisual = null;
    this.lineVisual = null;
    this.fanEffectTimer = 0;
    this.lineEffectTimer = 0;
    return null;
  }
}

/**
 * EyeForAnEyeSkill (Skill slot 2, Benedetta only - "An Eye for an Eye")
 * ------------------------------------------------------
 * A defensive parry:
 *
 *   idle --(cast)--> stance (0.8s, immune to ALL damage & crowd control)
 *     --(hit while in stance)--> parry! dash fires immediately, WITH a stun
 *     --(stance runs out untouched)--> dash fires anyway, WITHOUT a stun
 *   --> idle (on cooldown, once the dash finishes)
 *
 * The dash is a single fast, short forward burst that passes straight
 * through every hostile in its path - not a stop-on-hit projectile -
 * damaging each one it touches, and (only if the stance was actually
 * tested by an incoming hit) stunning them too.
 * ------------------------------------------------------
 */
class EyeForAnEyeSkill {
  constructor() {
    this.slot = 2;
    this.name = 'An Eye for an Eye';
    this.locked = false;

    this.maxCooldown = 8500; // ms
    this.cooldownRemaining = 0;

    this.stanceDuration = 500; // ms - "0.8 seconds"

    // Locked stance position to prevent any external displacement
    this._lockedStanceX = 0;
    this._lockedStanceY = 0;

    this.dashDistance = 190; // px, "fast forward dash"
    this.dashDuration = 180; // ms
    this.dashDamage = 30; // physical damage, per enemy hit
    this.dashHitRadius = 46; // px reach around the caster's current position during the dash
    this.stunDuration = 1000; // ms - only applied if an attack was actually parried

    // 'idle' | 'stance' | 'dashing'
    this.phase = 'idle';
    this.stanceTimer = 0;
    this.dashTimer = 0;
    this.wasParried = false; // whether THIS cast actually blocked a hit

    this.dirVec = SKILL_DIRECTION_VECTORS.down;
    this.dashFromX = 0;
    this.dashFromY = 0;
    this.dashToX = 0;
    this.dashToY = 0;
    this._lockedDashFromX = 0;
    this._lockedDashFromY = 0;
    this.hitTargetsThisDash = new Set();

    // Tracked every frame while in the stance so draw() - which never
    // gets a live caster reference - still knows where to put the
    // shield glow.
    this.stanceX = 0;
    this.stanceY = 0;

    // Afterimages during the dash - same look as Phantom Slash's trail.
    this.afterimages = [];
    this.afterimageTimer = 0;
    this._activeCaster = null;

    // Parry flash, played the instant an incoming hit is blocked.
    this.parryFlashTimer = 0;
    this.parryFlashDuration = 250;
    this.parryX = 0;
    this.parryY = 0;

    // Stored so reset() (called by Skill 3) can safely clear
    // isInvulnerable on whoever cast this, even mid-stance.
    this._activeCaster = null;
    this._onHitKill = null;
  }

  get isReady() {
    return this.phase === 'idle' && this.cooldownRemaining <= 0;
  }

  get isCasting() {
    return this.phase !== 'idle';
  }

  /**
   * @param {Player} caster
   * @param {EffectSystem} effects
   * @param {(target:Object) => void} onHitKill
   * @param {Array} hostiles - unused at cast time; the dash gathers
   *        its own hostiles each frame via update(), same as every
   *        other multi-hit skill in this file.
   */
  tryCast(caster, effects, onHitKill, hostiles) {
    if (caster.isDead) return false;
    if (!this.isReady) return false;

    this.phase = 'stance';
    this.stanceTimer = this.stanceDuration;
    this.wasParried = false;
    this._onHitKill = onHitKill;
    this._activeCaster = caster;
    this.stanceX = caster.x;
    this.stanceY = caster.y;
    // Lock the stance position absolutely - nothing can move her from here
    this._lockedStanceX = caster.x;
    this._lockedStanceY = caster.y;
    caster.isMovementLocked = true;

    // The whole point of the stance: nothing can touch her - Combat's
    // applyDamage/applySlow/applyStun all check isInvulnerable first.
    caster.isInvulnerable = true;
    caster.isCrowdControlImmune = true;
    caster.tookHitWhileInvulnerable = false;
    caster.tookCrowdControlWhileInvulnerable = false;

    return true;
  }

  update(deltaTime, hostiles, effects, onHitKill, caster) {
    if (this.cooldownRemaining > 0) {
      this.cooldownRemaining -= deltaTime;
    }

    if (this.parryFlashTimer > 0) this.parryFlashTimer -= deltaTime;
    for (const img of this.afterimages) img.life -= deltaTime;
    this.afterimages = this.afterimages.filter(img => img.life > 0);

    if (this.phase === 'stance') {
      this.stanceTimer -= deltaTime;
      // Force Benedetta to remain immovable at her locked stance position
      // This prevents ANY external displacement (including Chou's knockback)
      // Safety check: if locked positions aren't set, use current position
      if (this._lockedStanceX === 0 && this._lockedStanceY === 0) {
        this._lockedStanceX = caster.x;
        this._lockedStanceY = caster.y;
        console.log('Benedetta stance - initialized locked position:', this._lockedStanceX, this._lockedStanceY);
      }
      caster.x = this._lockedStanceX;
      caster.y = this._lockedStanceY;
      // Also update the tracking position for visual effects
      this.stanceX = this._lockedStanceX;
      this.stanceY = this._lockedStanceY;

      if (this.stanceTimer <= 0) {
        // The stance always lasts its full 0.4 seconds. A blocked stun
        // (or other true CC) only arms the stun for this outgoing dash;
        // it never cuts the defensive window short.
        if (caster.tookCrowdControlWhileInvulnerable) {
          this._triggerParry(caster, effects);
        } else {
          caster.isInvulnerable = false;
          // Don't set isCrowdControlImmune false here - the dash will maintain it
        }
        this._beginDash(caster, effects);
      }
      return;
    }

    if (this.phase === 'dashing') {
      this.dashTimer += deltaTime;
      const t = Math.min(1, this.dashTimer / this.dashDuration);
      // Force position from locked dash start to prevent external CC from hijacking her
      // This ensures she always ends up at the intended dash destination regardless of
      // any external position manipulation (like Chou's ult)
      caster.x = this._lockedDashFromX + (this.dashToX - this._lockedDashFromX) * t;
      caster.y = this._lockedDashFromY + (this.dashToY - this._lockedDashFromY) * t;

      this.afterimageTimer -= deltaTime;
      if (this.afterimageTimer <= 0) {
        this.afterimages.push({ x: caster.x, y: caster.y, life: 200, maxLife: 200 });
        this.afterimageTimer = 30;
      }

      this._hitTestDash(caster.x, caster.y, hostiles, effects, onHitKill || this._onHitKill);

      if (t >= 1) {
        this.phase = 'idle';
        this._onHitKill = null;
        this._activeCaster = null;
        caster.isMovementLocked = false;
        caster.isCrowdControlImmune = false;
        this.cooldownRemaining = this.maxCooldown;
      }
    }
  }

  /**
   * Plays the parry burst after a crowd-control effect was blocked, then
   * ends the invulnerability window and begins the counter dash.
   */
  _triggerParry(caster, effects) {
    caster.isInvulnerable = false;
    // Keep isCrowdControlImmune true during the dash to prevent
    // external position manipulation
    caster.isCrowdControlImmune = true;
    caster.tookHitWhileInvulnerable = false;
    caster.tookCrowdControlWhileInvulnerable = false;
    this.wasParried = true;

    this.parryX = caster.x;
    this.parryY = caster.y;
    this.parryFlashTimer = this.parryFlashDuration;
    effects.spawnAttackEffect(caster.x, caster.y, caster.x, caster.y, '#ffffff');
  }

  /**
   * Starts the forward dash from the caster's current position, in
   * whatever direction they're currently facing, clamped to the map.
   */
  _beginDash(caster, effects) {
    this.dirVec = SKILL_DIRECTION_VECTORS[caster.direction] || SKILL_DIRECTION_VECTORS.down;
    // Store the absolute start position - this must never be modified during the dash
    // Always use caster's current position as the dash start (which should be the locked stance position)
    this.dashFromX = caster.x;
    this.dashFromY = caster.y;
    // Create frozen copies to prevent any external modification
    this._lockedDashFromX = caster.x;
    this._lockedDashFromY = caster.y;

    let destX = this.dashFromX + this.dirVec.x * this.dashDistance;
    let destY = this.dashFromY + this.dirVec.y * this.dashDistance;

    if (caster.mapBounds) {
      const halfWidth = (caster.collisionWidth || 28) / 2;
      const halfHeight = (caster.collisionHeight || 20) / 2;
      const clamped = Collision.clampToMap(destX, destY, halfWidth, halfHeight, caster.mapBounds);
      destX = clamped.x;
      destY = clamped.y;
    }

    this.dashToX = destX;
    this.dashToY = destY;
    this.phase = 'dashing';
    this.dashTimer = 0;
    this.hitTargetsThisDash = new Set();
    this.afterimageTimer = 0;
    
    // Maintain crowd control immunity during the dash to prevent
    // external skills (like Chou's ult) from hijacking her position
    caster.isCrowdControlImmune = true;

    effects.spawnAttackEffect(this.dashFromX, this.dashFromY, this.dashToX, this.dashToY, '#ce93d8');
  }

  /**
   * Per-frame hit-test during the dash: anything within reach of the
   * caster's CURRENT position that hasn't already been hit this dash
   * takes damage - and a stun too, if the stance actually parried a hit.
   * Never stops the dash itself, so she passes straight through.
   */
  _hitTestDash(casterX, casterY, hostiles, effects, onHitKill) {
    for (const target of hostiles) {
      if (!target || target.hp <= 0) continue;
      if (this.hitTargetsThisDash.has(target)) continue;

      const targetRadius = target.drawWidth ? target.drawWidth / 2 : 20;
      if (Combat.distance(casterX, casterY, target.x, target.y) <= this.dashHitRadius + targetRadius) {
        const killed = Combat.applyDamage(target, this.dashDamage);
        if (this.wasParried) {
          Combat.applyStun(target, this.stunDuration);
        }
        effects.spawnAttackEffect(casterX, casterY, target.x, target.y, '#ba68c8');
        this.hitTargetsThisDash.add(target);
        if (killed && onHitKill) onHitKill(target);
      }
    }
  }

  draw(ctx, camera) {
    // Shield glow while the stance is active, following wherever the
    // caster currently is while the block window is active.
    if (this.phase === 'stance') {
      const sx = camera.worldToScreenX(this.stanceX);
      const sy = camera.worldToScreenY(this.stanceY);
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(sx, sy, 30, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Parry flash - an expanding, fading ring at the moment of the block.
    if (this.parryFlashTimer > 0) {
      const alpha = this.parryFlashTimer / this.parryFlashDuration;
      const sx = camera.worldToScreenX(this.parryX);
      const sy = camera.worldToScreenY(this.parryY);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(sx, sy, 40 * (1 - alpha) + 18, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Afterimages left behind by the dash.
    for (const img of this.afterimages) {
      const alpha = Math.max(0, img.life / img.maxLife) * 0.4;
      const sx = camera.worldToScreenX(img.x);
      const sy = camera.worldToScreenY(img.y);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#ce93d8';
      ctx.beginPath();
      ctx.ellipse(sx, sy, 16, 24, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  /**
   * Fully returns this skill to a fresh, immediately-castable state.
   * Also safely lifts the invulnerability lock on whoever cast it, in
   * case Skill 3 resets this mid-stance (otherwise the caster would be
   * stuck permanently immune).
   * @returns {null}
   */
  reset() {
    if (this._activeCaster) {
      this._activeCaster.isInvulnerable = false;
      this._activeCaster.isCrowdControlImmune = false;
      this._activeCaster.isMovementLocked = false;
    }
    this.phase = 'idle';
    this.cooldownRemaining = 0;
    this.stanceTimer = 0;
    this.dashTimer = 0;
    this._onHitKill = null;
    this._activeCaster = null;
    this.wasParried = false;
    this._lockedDashFromX = 0;
    this._lockedDashFromY = 0;
    this._lockedStanceX = 0;
    this._lockedStanceY = 0;
    return null;
  }
}

/**
 * SwordWaveBlade
 * ------------------------------------------------------
 * A single blade thrown by Sword Waves. Extends Projectile so it
 * looks exactly like Skill 1's bolt (same trail + glow rendering)
 * and reuses its constructor, but overrides the movement/collision
 * logic entirely: it pierces every hostile in its path (instead of
 * stopping at the first one) and flies in two distinct legs - out
 * to its max range, then back to wherever the caster currently is.
 * ------------------------------------------------------
 */
class SwordWaveBlade extends Projectile {
  /**
   * @param {number} x - starting world x (the caster's position)
   * @param {number} y - starting world y
   * @param {number} angle - travel angle in radians
   * @param {number} damage - damage dealt per hostile hit, per leg
   * @param {number} speed - px/sec
   * @param {number} range - px this blade flies out before turning back
   */
  constructor(x, y, angle, damage, speed, range) {
    super(x, y, { x: Math.cos(angle), y: Math.sin(angle) }, damage, speed, range);

    // 'outbound' -> 'holding' (waiting for recast) -> 'returning' -> 'done'
    this.phase = 'outbound';

    // Tracked separately per leg so a blade can hit the same target
    // once on the way out AND once on the way back, without ever
    // double-hitting within a single leg.
    this.hitTargetsOutbound = new Set();
    this.hitTargetsReturn = new Set();
  }

  /**
   * Advances the outbound leg: flies straight out, damaging/slowing
   * every hostile it touches along the way, until it reaches its range.
   */
  updateOutbound(deltaTime, hostiles, effects, onHitKill, slowMultiplier, slowDuration) {
    if (this.phase !== 'outbound') return;

    this.trail.push({ x: this.x, y: this.y });
    if (this.trail.length > this.maxTrailPoints) this.trail.shift();

    const step = this.speed * (deltaTime / 1000);
    this.x += this.dirX * step;
    this.y += this.dirY * step;
    this.traveled += step;

    this._checkHits(hostiles, effects, onHitKill, this.hitTargetsOutbound, slowMultiplier, slowDuration);

    if (this.traveled >= this.maxDistance) {
      this.phase = 'holding'; // reached max range - waits here for the recast
    }
  }

  /**
   * Advances the return leg: homes in on the caster's CURRENT
   * position (not where they cast from), damaging/slowing anything
   * it passes through on the way, and finishes once it arrives.
   */
  updateReturn(deltaTime, hostiles, effects, onHitKill, casterX, casterY, slowMultiplier, slowDuration) {
    if (this.phase !== 'returning') return;

    this.trail.push({ x: this.x, y: this.y });
    if (this.trail.length > this.maxTrailPoints) this.trail.shift();

    const dx = casterX - this.x;
    const dy = casterY - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const step = this.speed * (deltaTime / 1000);

    if (dist <= step) {
      this.phase = 'done';
      return;
    }

    this.x += (dx / dist) * step;
    this.y += (dy / dist) * step;

    this._checkHits(hostiles, effects, onHitKill, this.hitTargetsReturn, slowMultiplier, slowDuration);
  }

  /**
   * Shared hit-detection for both legs: damages/slows every hostile
   * within range that hasn't already been hit during this leg.
   */
  _checkHits(hostiles, effects, onHitKill, hitSet, slowMultiplier, slowDuration) {
    for (const target of hostiles) {
      if (!target || target.hp <= 0) continue;
      if (hitSet.has(target)) continue;

      const targetRadius = target.drawWidth ? target.drawWidth / 2 : 20;
      if (Combat.distance(this.x, this.y, target.x, target.y) <= this.hitRadius + targetRadius) {
        const killed = Combat.applyDamage(target, this.damage);
        Combat.applySlow(target, slowMultiplier, slowDuration);
        effects.spawnAttackEffect(this.x, this.y, this.x, this.y, '#4fc3f7');
        hitSet.add(target);
        if (killed && onHitKill) onHitKill(target);
      }
    }
  }

  /**
   * Begins the return leg.
   */
  startReturn() {
    this.phase = 'returning';
  }
}

/**
 * SwordWavesSkill (Skill slot 2)
 * ------------------------------------------------------
 * A 2-phase ability, same pattern as Skill 1:
 *
 *   idle --(cast)--> 5 blades fan out --(reach max range)--> holding, awaiting recast --(cast)--> blades fly back to caster --> idle (on cooldown)
 *                                                                    |
 *                                                             (window expires)
 *                                                                    v
 *                                                          idle (on cooldown, blades lost)
 *
 * Every hostile a blade touches - on either leg - takes damage and
 * is slowed, so a well-aimed throw can hit the same target twice:
 * once going out, once coming back.
 * ------------------------------------------------------
 */
class SwordWavesSkill {
  constructor() {
    this.slot = 2;
    this.name = 'Sword Waves';
    this.locked = false;
    this.recastLabel = 'RETURN!';

    // Blade fan stats
    this.bladeCount = 5;
    this.spreadAngle = Math.PI / 3; // 60 degrees total, spread evenly across all 5 blades
    this.bladeSpeed = 910; // increased by 30% (was 700)
    this.bladeRange = 300;
    this.damage = 11; // per blade, per leg (a blade that hits the same target twice deals 22 total) - reduced by 30%

    this.slowMultiplier = 1; // no slow
    this.slowDuration = 0; // no slow

    this.maxCooldown = 7000; // ms, only starts once the ability fully resolves
    this.cooldownRemaining = 0;

    this.recastWindow = 5000; // ms to call the blades back before they're auto-recalled
    this.recastTimer = 0;

    // 'idle' | 'outbound' | 'awaiting_recast' | 'returning'
    this.phase = 'idle';
    this.blades = [];

    // Blades carried over from a volley cut short by Skill 3. They
    // remain only briefly, then disappear automatically.
    this.heldBlades = [];
    this.heldBladeLifetime = 10000;

    // Every blade shares the same speed/range, so they all finish
    // their outbound leg at the same moment - one shared timer is
    // simpler than polling each blade's individual state.
    this.outboundDuration = (this.bladeRange / this.bladeSpeed) * 1000;
    this.outboundTimer = 0;
  }

  get isReady() {
    return this.phase === 'idle' && this.cooldownRemaining <= 0;
  }

  /**
   * Behavior depends on the current phase:
   *  - awaiting_recast: calls the blades back (phase 2).
   *  - otherwise: throws the 5-blade fan, if off cooldown.
   * @param {Player} caster
   * @param {EffectSystem} effects
   * @param {(target:Object) => void} onHitKill
   * @param {Array} hostiles - unused here; the blades gather their own
   *        hostiles each frame via update(), same as Skill 1's bolt.
   */
  tryCast(caster, effects, onHitKill, hostiles) {
    if (caster.isDead) return false;

    if (this.phase === 'awaiting_recast') {
      this._executeReturn(caster, effects);
      return true;
    }

    if (!this.isReady) return false;

    const dirVec = SKILL_DIRECTION_VECTORS[caster.direction] || SKILL_DIRECTION_VECTORS.down;
    const centerAngle = Math.atan2(dirVec.y, dirVec.x);

    const newBlades = [];
    for (let i = 0; i < this.bladeCount; i++) {
      // Spread the blades evenly across the fan, centered on facing direction.
      const t = this.bladeCount === 1 ? 0.5 : i / (this.bladeCount - 1);
      const angle = centerAngle - this.spreadAngle / 2 + t * this.spreadAngle;
      newBlades.push(new SwordWaveBlade(caster.x, caster.y, angle, this.damage, this.bladeSpeed, this.bladeRange));
    }

    // Any blades held over from a volley the ultimate cut short join
    // this fresh fan, so the next recast calls all of them home together.
    this.blades = [...this.heldBlades, ...newBlades];
    this.heldBlades = [];

    effects.spawnAttackEffect(caster.x, caster.y, caster.x, caster.y, '#4fc3f7');

    this.phase = 'outbound';
    this.outboundTimer = 0;
    return true;
  }

  /**
   * @param {number} deltaTime
   * @param {Array} hostiles
   * @param {EffectSystem} effects
   * @param {(target:Object) => void} onHitKill
   * @param {Player} caster - needed so the return leg can home in on
   *        wherever the caster currently is, not just where they cast from
   */
  update(deltaTime, hostiles, effects, onHitKill, caster) {
    if (this.cooldownRemaining > 0) {
      this.cooldownRemaining -= deltaTime;
    }

    // Skill 3 gives already-thrown blades a ten-second lifetime.
    // Keep it on each blade so it still expires if it joins a later cast.
    for (const blade of [...this.blades, ...this.heldBlades]) {
      if (blade.despawnRemaining == null) continue;
      blade.despawnRemaining -= deltaTime;
      if (blade.despawnRemaining <= 0) blade.phase = 'done';
    }
    this.blades = this.blades.filter(blade => blade.phase !== 'done');
    this.heldBlades = this.heldBlades.filter(blade => blade.phase !== 'done');

    // Held-over blades from an interrupted volley keep going on their
    // own timeline - independent of whatever this.phase is doing -
    // until a fresh cast folds them back into this.blades.
    if (this.heldBlades.length > 0) {
      for (const blade of this.heldBlades) {
        if (blade.phase === 'outbound') {
          blade.updateOutbound(deltaTime, hostiles, effects, onHitKill, this.slowMultiplier, this.slowDuration);
        } else if (blade.phase === 'returning') {
          blade.updateReturn(deltaTime, hostiles, effects, onHitKill, caster.x, caster.y, this.slowMultiplier, this.slowDuration);
        }
        // 'holding' blades just wait as-is - nothing to advance.
      }
      this.heldBlades = this.heldBlades.filter(blade => blade.phase !== 'done');
    }

    if (this.phase === 'outbound') {
      this.outboundTimer += deltaTime;
      for (const blade of this.blades) {
        blade.updateOutbound(deltaTime, hostiles, effects, onHitKill, this.slowMultiplier, this.slowDuration);
      }
      if (this.outboundTimer >= this.outboundDuration) {
        // All blades have reached max range - open the recast window.
        this.phase = 'awaiting_recast';
        this.recastTimer = this.recastWindow;
        console.log('Skill 2 phase 1 complete, entering awaiting_recast with timer:', this.recastTimer);
      }
      return;
    }

    if (this.phase === 'awaiting_recast') {
      this.recastTimer -= deltaTime;
      if (this.recastTimer <= 0) {
        // Window expired: auto-cast phase 2 to return blades instead of losing them.
        console.log('Auto-casting Skill 2 phase 2 after 5 seconds');
        this._executeReturn(caster, effects);
      }
      return;
    }

    if (this.phase === 'returning') {
      let anyStillFlying = false;
      for (const blade of this.blades) {
        blade.updateReturn(deltaTime, hostiles, effects, onHitKill, caster.x, caster.y, this.slowMultiplier, this.slowDuration);
        if (blade.phase !== 'done') anyStillFlying = true;
      }
      // Also update held blades that are returning
      for (const blade of this.heldBlades) {
        if (blade.phase === 'returning') {
          blade.updateReturn(deltaTime, hostiles, effects, onHitKill, caster.x, caster.y, this.slowMultiplier, this.slowDuration);
          if (blade.phase !== 'done') anyStillFlying = true;
        }
      }
      if (!anyStillFlying) {
        this.blades = [];
        this.heldBlades = this.heldBlades.filter(blade => blade.phase !== 'done');
        this.phase = 'idle';
        // Death can begin this cooldown while blades are still returning.
        // Preserve that already-running timer instead of restarting it.
        if (this.cooldownRemaining <= 0) this.cooldownRemaining = this.maxCooldown;
      }
    }
  }

  /**
   * Executes phase 2: every held blade starts homing back toward
   * the caster's current position.
   */
  _executeReturn(caster, effects) {
    for (const blade of this.blades) {
      blade.startReturn();
    }
    // Also return any held blades that are in 'holding' phase and fold them into main blades
    const holdingBlades = this.heldBlades.filter(blade => blade.phase === 'holding');
    for (const blade of holdingBlades) {
      blade.startReturn();
      this.blades.push(blade);
    }
    // Remove the moved blades from heldBlades
    this.heldBlades = this.heldBlades.filter(blade => blade.phase !== 'holding');
    effects.spawnAttackEffect(caster.x, caster.y, caster.x, caster.y, '#1e88e5');
    this.phase = 'returning';
  }

  draw(ctx, camera) {
    for (const blade of this.blades) {
      blade.draw(ctx, camera, '#4fc3f7');
    }
    for (const blade of this.heldBlades) {
      blade.draw(ctx, camera, '#4fc3f7');
    }
  }

  /**
   * Fully returns this skill SLOT to a fresh, immediately-castable
   * state - but unlike BladeThrowSkill, it does NOT discard blades
   * that are already out in the world. Instead, any active blades
   * (flying, holding, or already returning) are moved into
   * heldBlades, where they keep advancing on their own every frame
   * and get folded into the NEXT volley this skill throws. That's
   * what makes the Gusion-style "10 blades" combo possible: throw
   * (5 blades hold at range), cast the ultimate (this skill resets
   * to idle, but those 5 blades stay out), throw again (5 more
   * blades join them), then recast once more to call all 10 home
   * together.
   * @returns {null} nothing for the caller to track separately -
   *          the blades keep living inside this same skill instance
   */
  reset() {
    if (this.blades.length > 0) {
      for (const blade of this.blades) {
        blade.despawnRemaining = this.heldBladeLifetime;
      }
      this.heldBlades.push(...this.blades);
    }

    this.phase = 'idle';
    this.cooldownRemaining = 0;
    this.blades = [];
    this.outboundTimer = 0;
    this.recastTimer = 0;

    return null;
  }
}

/**
 * UltimateSkill (Skill slot 3 - "Blade Dance")
 * ------------------------------------------------------
 * A 2-phase mobility ultimate, same recast pattern as Skills 1 and 2,
 * but with no damage of its own:
 *
 *   idle --(cast)--> instant short-range teleport, Skills 1 & 2's
 *                     cooldowns are reset --> awaiting_recast --(cast)-->
 *                     short animated dash (no damage) --> idle (on cooldown)
 *                                                    |
 *                                             (window expires)
 *                                                    v
 *                                          idle (on cooldown, no dash)
 *
 * The whole point of phase 1 is the cooldown reset - instantly
 * making Blade Throw and Sword Waves available again for a follow-up
 * combo. Phase 2 is purely a repositioning tool.
 * ------------------------------------------------------
 */
class UltimateSkill {
  constructor() {
    this.slot = 3;
    this.name = 'Blade Dance';
    this.locked = false;
    this.recastLabel = 'DASH!';

    this.teleportRange = 220; // short-range blink, phase 1
    this.dashRange = 140;     // shorter follow-up dash, phase 2 (no damage)
    this.dashDuration = 200;  // ms, how long the phase-2 dash animation takes

    // Long cooldown befitting an ultimate that resets two other skills.
    this.maxCooldown = 14000; // ms
    this.cooldownRemaining = 0;

    this.recastWindow = 5000; // ms to trigger the follow-up dash

    // 'idle' | 'awaiting_recast'
    this.phase = 'idle';
    this.recastTimer = 0;

    // Phase-2 dash animation state (mirrors BladeThrowSkill's dash).
    this.isDashing = false;
    this.dashTimer = 0;
    this.dashFromX = 0;
    this.dashFromY = 0;
    this.dashToX = 0;
    this.dashToY = 0;
    this._dashCaster = null;

    // Set by SkillManager right after construction: direct references
    // to Skills 1 & 2, so phase 1 can instantly refresh their cooldowns.
    this.siblingSkills = [];
  }

  get isReady() {
    return this.phase === 'idle' && this.cooldownRemaining <= 0 && !this.isDashing;
  }

  get isCasting() {
    return this.isDashing;
  }

  /**
   * Behavior depends on the current phase:
   *  - awaiting_recast: triggers the phase-2 dash.
   *  - otherwise: teleports and resets Skills 1 & 2, if off cooldown.
   * @param {Player} caster
   * @param {EffectSystem} effects
   * @param {(target:Object) => void} onHitKill - unused; this skill deals no damage
   * @param {Array} hostiles - unused; this skill deals no damage
   */
  tryCast(caster, effects, onHitKill, hostiles) {
    if (caster.isDead) return false;

    if (this.phase === 'awaiting_recast') {
      this._executeDash(caster, effects);
      return true;
    }

    if (!this.isReady) return false;

    this._executeTeleport(caster, effects);
    return true;
  }

  /**
   * Phase 1: an instant blink in the direction the caster is facing,
   * clamped to stay inside the map, followed by an immediate reset
   * of Skill 1 and Skill 2's cooldowns.
   */
  _executeTeleport(caster, effects) {
    const dest = this._resolveDestination(caster, this.teleportRange);
    const originX = caster.x;
    const originY = caster.y;

    caster.x = dest.x;
    caster.y = dest.y;

    // Departure + arrival flashes so the blink actually reads as a
    // teleport rather than a snap-to-position glitch.
    effects.spawnAttackEffect(originX, originY, originX, originY, '#ab47bc');
    effects.spawnAttackEffect(dest.x, dest.y, dest.x, dest.y, '#ce93d8');

    // The payoff: both siblings get their SLOT reset to a fresh,
    // ready-to-cast state. Skill 1 (Blade Throw) has nothing worth
    // preserving mid-recast, so its reset is a clean wipe. Sword Waves
    // keeps any blades already in the world for up to ten seconds.
    for (const skill of this.siblingSkills) {
      if (typeof skill.reset === 'function') {
        skill.reset();
      } else {
        skill.cooldownRemaining = 0;
      }
    }

    this.phase = 'awaiting_recast';
    this.recastTimer = this.recastWindow;
  }

  /**
   * Phase 2: a short animated dash, purely for repositioning - deals
   * no damage and doesn't touch Skill 1/2's cooldowns again.
   */
  _executeDash(caster, effects) {
    const dest = this._resolveDestination(caster, this.dashRange);

    this.dashFromX = caster.x;
    this.dashFromY = caster.y;
    this.dashToX = dest.x;
    this.dashToY = dest.y;
    this.isDashing = true;
    this.dashTimer = 0;
    this._dashCaster = caster;

    // Benedetta is committed to the follow-up dash animation, so
    // held movement input cannot pull her off its scripted path.
    if (caster.character === 'benedetta') {
      caster.isMovementLocked = true;
    }

    effects.spawnAttackEffect(this.dashFromX, this.dashFromY, this.dashToX, this.dashToY, '#ce93d8');

    this.phase = 'idle';
    this.cooldownRemaining = this.maxCooldown;
  }

  /**
   * Shared helper: projects a point `distance` px in front of the
   * caster (their current facing direction) and clamps it to stay
   * inside the map, so neither the blink nor the dash can send the
   * caster out of bounds.
   */
  _resolveDestination(caster, distance) {
    const dirVec = SKILL_DIRECTION_VECTORS[caster.direction] || SKILL_DIRECTION_VECTORS.down;
    let x = caster.x + dirVec.x * distance;
    let y = caster.y + dirVec.y * distance;

    if (caster.mapBounds) {
      const halfWidth = (caster.collisionWidth || 28) / 2;
      const halfHeight = (caster.collisionHeight || 20) / 2;
      const clamped = Collision.clampToMap(x, y, halfWidth, halfHeight, caster.mapBounds);
      x = clamped.x;
      y = clamped.y;
    }

    return { x, y };
  }

  /**
   * Advances the phase-2 dash animation (if active) and the recast
   * countdown (if waiting on one).
   * @param {number} deltaTime
   * @param {Array} hostiles - unused
   * @param {EffectSystem} effects - unused
   * @param {(target:Object) => void} onHitKill - unused
   * @param {Player} caster - needed to move the caster during the dash
   */
  update(deltaTime, hostiles, effects, onHitKill, caster) {
    if (this.cooldownRemaining > 0) {
      this.cooldownRemaining -= deltaTime;
    }

    if (this.isDashing) {
      this.dashTimer += deltaTime;
      const t = Math.min(1, this.dashTimer / this.dashDuration);
      caster.x = this.dashFromX + (this.dashToX - this.dashFromX) * t;
      caster.y = this.dashFromY + (this.dashToY - this.dashFromY) * t;
      if (t >= 1) {
        this.isDashing = false;
        if (caster.character === 'benedetta') {
          caster.isMovementLocked = false;
        }
        this._dashCaster = null;
      }
      return;
    }

    if (this.phase === 'awaiting_recast') {
      this.recastTimer -= deltaTime;
      if (this.recastTimer <= 0) {
        // Window expired: no free dash, but the cooldown reset from
        // phase 1 already happened and isn't undone.
        this.phase = 'idle';
        this.cooldownRemaining = this.maxCooldown;
      }
    }
  }

  draw(ctx, camera) {
    // Nothing persistent to draw - both the blink and the dash are
    // one-shot bursts already handled by the shared EffectSystem.
  }

  // Used when death interrupts the blink's recast window or dash.
  reset() {
    if (this._dashCaster) this._dashCaster.isMovementLocked = false;
    this.phase = 'idle';
    this.recastTimer = 0;
    this.isDashing = false;
    this.dashTimer = 0;
    this._dashCaster = null;
    this.cooldownRemaining = 0;
    return null;
  }
}

/**
 * ShurikenBlade
 * ------------------------------------------------------
 * A single shuriken thrown by Phantom Shuriken. Identical flight
 * behavior to SwordWaveBlade (pierces every hostile, flies out to
 * max range, then homes back to the caster) - it's just given its
 * own name here so Hayabusa's skill code doesn't read like it's
 * borrowing Gusion's blades.
 * ------------------------------------------------------
 */
class ShurikenBlade extends SwordWaveBlade {}

/**
 * PhantomShurikenSkill (Skill slot 1, Hayabusa)
 * ------------------------------------------------------
 * A single-cast ability - unlike Gusion's Blade Throw, there's no
 * recast button to press. One press of "1" throws all 3 shuriken at
 * once in a narrow fan; each one pierces every hostile in its path,
 * flies out to its max range, then automatically boomerangs back to
 * wherever the caster currently is, hitting anything in the way a
 * second time on the way home. This mirrors Hayabusa's Phantom
 * Shuriken in the real game: throw once, the shuriken do the rest.
 *
 *   idle --(cast)--> 3 shuriken fan out --(reach max range)--> auto-turn, fly home --(all arrive)--> idle (on cooldown)
 *
 * Cooldown starts the moment you cast, since there's no decision to
 * wait on - the whole throw-and-return resolves on its own.
 * ------------------------------------------------------
 */
class PhantomShurikenSkill {
  constructor() {
    this.slot = 1;
    this.name = 'Phantom Shuriken';
    this.locked = false;
    this.recastLabel = null; // no recast window - this skill never shows one

    // Shuriken fan stats
    this.shurikenCount = 3;
    this.spreadAngle = Math.PI / 6; // 30 degrees total, spread evenly across all 3 shuriken
    this.shurikenSpeed = 910;
    this.shurikenRange = 285; // reduced by 10% (was 320)
    this.damage = 11; // per shuriken, per leg - reduced by 30% (was 16)

    this.maxCooldown = 2500; // ms - reduced by 1.5s (was 5000)
    this.cooldownRemaining = 0;

    // 'idle' | 'outbound' | 'returning' - bookkeeping only; recasting
    // is never gated on this since the cast resolves in one press.
    this.phase = 'idle';
    this.shurikens = [];

    // Every shuriken shares the same speed/range, so they all finish
    // their outbound leg at the same moment - one shared timer is
    // simpler than polling each shuriken's individual state.
    this.outboundDuration = (this.shurikenRange / this.shurikenSpeed) * 1000;
    this.outboundTimer = 0;
  }

  get isReady() {
    return this.cooldownRemaining <= 0;
  }

  /**
   * Throws all 3 shuriken in one press - no phases for the player to
   * manage, the whole out-and-back happens automatically.
   * @param {Player} caster
   * @param {EffectSystem} effects
   * @param {(target:Object) => void} onHitKill
   * @param {Array} hostiles - unused here; each shuriken gathers its
   *        own hostiles every frame via update(), same as Sword Waves.
   */
  tryCast(caster, effects, onHitKill, hostiles) {
    if (caster.isDead || !this.isReady) return false;

    const dirVec = SKILL_DIRECTION_VECTORS[caster.direction] || SKILL_DIRECTION_VECTORS.down;
    const centerAngle = Math.atan2(dirVec.y, dirVec.x);

    this.shurikens = [];
    for (let i = 0; i < this.shurikenCount; i++) {
      // Spread the shuriken evenly across the fan, centered on facing direction.
      const t = this.shurikenCount === 1 ? 0.5 : i / (this.shurikenCount - 1);
      const angle = centerAngle - this.spreadAngle / 2 + t * this.spreadAngle;
      this.shurikens.push(new ShurikenBlade(caster.x, caster.y, angle, this.damage, this.shurikenSpeed, this.shurikenRange));
    }

    effects.spawnAttackEffect(caster.x, caster.y, caster.x, caster.y, '#ffca28');

    this.phase = 'outbound';
    this.outboundTimer = 0;
    // Cooldown starts right away - a single clean cast, nothing to wait on.
    this.cooldownRemaining = this.maxCooldown;
    return true;
  }

  /**
   * @param {Player} caster - needed so the return leg can home in on
   *        wherever the caster currently is, not just where they cast from.
   */
  update(deltaTime, hostiles, effects, onHitKill, caster) {
    if (this.cooldownRemaining > 0) {
      this.cooldownRemaining -= deltaTime;
    }

    if (this.phase === 'outbound') {
      this.outboundTimer += deltaTime;
      for (const shuriken of this.shurikens) {
        shuriken.updateOutbound(deltaTime, hostiles, effects, onHitKill, 1, 0);
      }
      if (this.outboundTimer >= this.outboundDuration) {
        // Max range reached - turn the shuriken around automatically.
        for (const shuriken of this.shurikens) {
          shuriken.startReturn();
        }
        this.phase = 'returning';
      }
      return;
    }

    if (this.phase === 'returning') {
      let anyStillFlying = false;
      for (const shuriken of this.shurikens) {
        shuriken.updateReturn(deltaTime, hostiles, effects, onHitKill, caster.x, caster.y, 1, 0);
        if (shuriken.phase !== 'done') anyStillFlying = true;
      }
      if (!anyStillFlying) {
        this.shurikens = [];
        this.phase = 'idle';
      }
    }
  }

  draw(ctx, camera) {
    for (const shuriken of this.shurikens) {
      shuriken.draw(ctx, camera, '#df5e08');
    }
  }

  /**
   * Fully returns this slot to a fresh, immediately-castable state -
   * used if the ultimate's cooldown-reset ever targets Skill 1 for a
   * Hayabusa caster (currently the ultimate stays Gusion's, so this
   * mainly just mirrors BladeThrowSkill.reset() for interface parity).
   */
  reset() {
    this.phase = 'idle';
    this.cooldownRemaining = 0;
    this.shurikens = [];
    this.outboundTimer = 0;
    return null;
  }
}

/**
 * ShadowClone
 * ------------------------------------------------------
 * A single shadow spawned by Quad Shadow. Travels in a straight
 * line to its max range, then stops and lingers there for a fixed
 * lifespan. At any point during either stage, the first hostile it
 * touches gets damaged, slowed, and "marked" (remembered on the
 * shadow itself) - after that it just sits there inert, since a
 * shadow only ever marks one target.
 * ------------------------------------------------------
 */
class ShadowClone {
  /**
   * @param {number} x - starting world x (where the caster dashed to)
   * @param {number} y - starting world y
   * @param {{x:number,y:number}} direction - unit vector to travel along
   * @param {number} speed - px/sec while traveling
   * @param {number} maxDistance - px the shadow travels before stopping
   */
  constructor(x, y, direction, speed, maxDistance) {
    this.x = x;
    this.y = y;
    this.dirX = direction.x;
    this.dirY = direction.y;
    this.speed = speed;
    this.maxDistance = maxDistance;
    this.traveled = 0;
    this.hitRadius = 16;

    // 'traveling' -> 'active' -> 'expired'
    this.phase = 'traveling';
    this.maxLife = 5000; // ms a landed shadow lingers before vanishing
    this.lifeRemaining = 0; // set once it reaches 'active'

    this.hitApplied = false; // true once this shadow has struck someone
    this.markedTarget = null; // the hostile this shadow is attached to, if any

    // Purely cosmetic idle motion so a field of stationary shadows
    // doesn't look like a frozen screenshot.
    this.bobTimer = Math.random() * 1000;
  }

  /**
   * @param {number} deltaTime - ms since last frame
   * @param {Array} hostiles
   * @param {EffectSystem} effects
   * @param {(target:Object) => void} onHitKill
   * @param {number} damage
   * @param {number} slowMultiplier - e.g. 0.6 for a 40% slow
   * @param {number} slowDuration - ms
   */
  update(deltaTime, hostiles, effects, onHitKill, damage, slowMultiplier, slowDuration, attachedHeroes = null) {
    this.bobTimer += deltaTime;

    // If shadow has a marked target that's still alive, stick to it
    if (this.hitApplied && this.markedTarget && this.markedTarget.hp > 0) {
      this.x = this.markedTarget.x;
      this.y = this.markedTarget.y;
    } else if (this.hitApplied && (!this.markedTarget || this.markedTarget.hp <= 0)) {
      // Target died - shadow expires
      this.phase = 'expired';
      return;
    }

    if (this.phase === 'traveling') {
      const step = this.speed * (deltaTime / 1000);
      this.x += this.dirX * step;
      this.y += this.dirY * step;
      this.traveled += step;

      if (this.traveled >= this.maxDistance) {
        this.phase = 'active';
        this.lifeRemaining = this.maxLife;
      }
    } else if (this.phase === 'active') {
      this.lifeRemaining -= deltaTime;
      if (this.lifeRemaining <= 0) {
        this.phase = 'expired';
        return;
      }
    } else {
      return; // already expired - nothing left to do
    }

    // Only check for collisions while traveling - not after landing
    if (this.phase !== 'traveling') return;

    if (this.hitApplied) return; // already marked a target - stays attached

    for (const target of hostiles) {
      if (!target || target.hp <= 0) continue;
      // Only affect enemy heroes, not creeps
      if (target instanceof Creep) continue;
      // Quad Shadow may attach only one clone to each enemy hero.
      if (attachedHeroes && attachedHeroes.has(target)) continue;
      const targetRadius = target.drawWidth ? target.drawWidth / 2 : 20;

      if (Combat.distance(this.x, this.y, target.x, target.y) <= this.hitRadius + targetRadius) {
        const killed = Combat.applyDamage(target, damage);
        Combat.applySlow(target, slowMultiplier, slowDuration);
        effects.spawnAttackEffect(this.x, this.y, target.x, target.y, '#781902');
        this.hitApplied = true;
        this.markedTarget = target;
        if (killed && onHitKill) onHitKill(target);
        break;
      }
    }
  }

  /**
   * Draws a translucent shadow-silhouette blob that bobs gently in
   * place, glows red and pulses once it has marked a target (so it's
   * obvious at a glance which shadow a teleport will prioritize), and
   * fades out over its last moments before expiring.
   */
  draw(ctx, camera) {
    if (this.phase === 'expired') return;

    const bob = Math.sin(this.bobTimer / 250) * 3;
    const sx = camera.worldToScreenX(this.x);
    const sy = camera.worldToScreenY(this.y) + bob;

    let alpha = 1;
    if (this.phase === 'active' && this.lifeRemaining < 800) {
      alpha = Math.max(0, this.lifeRemaining / 800);
    }

    ctx.save();
    ctx.globalAlpha = alpha * 0.85;

    const glowColor = this.hitApplied ? '#cb3f03' : '#170902';
    const gradient = ctx.createRadialGradient(sx, sy, 0, sx, sy, 22);
    gradient.addColorStop(0, 'rgba(238, 48, 0, 0.9)');
    gradient.addColorStop(0.7, glowColor);
    gradient.addColorStop(1, 'rgb(237, 78, 10)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.ellipse(sx, sy, 16, 20, 0, 0, Math.PI * 2);
    ctx.fill();

    // Pulsing outline once marked, so the "go-to" shadow reads clearly.
    if (this.hitApplied) {
      ctx.globalAlpha = alpha * (0.5 + 0.5 * Math.sin(this.bobTimer / 150));
      ctx.strokeStyle = '#ff8a80';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(sx, sy, 20, 24, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }
}

/**
 * QuadShadowSkill (Skill slot 2, Hayabusa)
 * ------------------------------------------------------
 * A 2-step ability, but unlike Blade Throw/Sword Waves the second
 * step is never lost to a timer - it just waits for however long the
 * shadows themselves last:
 *
 *   idle --(cast)--> short forward dash, 4 shadows launch outward (fwd/left/right/back)
 *                          |
 *                    each shadow travels out, stops, and lingers up to 4s
 *                          |
 *   (any press while shadows exist) --(teleport)--> caster blinks to the
 *          marked shadow (or nearest one), bonus damage if it's attached
 *          to an enemy, that shadow is consumed - the rest stay out
 *          |
 *   (all shadows consumed/expired) --> back to idle
 *
 * The 8s cooldown starts the instant the shadows are cast - the
 * follow-up teleport(s) are always free for as long as any shadow is
 * still out, and can be used more than once if multiple shadows are
 * still alive.
 * ------------------------------------------------------
 */
class QuadShadowSkill {
  constructor() {
    this.slot = 2;
    this.name = 'Quad Shadow';
    this.locked = false;
    this.recastLabel = 'TELEPORT!';

    // Initial cast: forward dash + 4-way shadow burst
    this.dashRange = 185; // px, short forward dash on cast
    this.dashDuration = 180; // ms

    this.shadowSpeed = 885;
    this.shadowRange = 260; // px each shadow travels before stopping and lingering

    this.hitDamage = 17; // Physical Damage dealt the instant a shadow touches an enemy - reduced by 30% (was 24)
    this.slowMultiplier = 0.6; // 40% slow
    this.slowDuration = 2000; // ms

    this.teleportBonusDamage = 21; // extra damage on arrival if the shadow used was marked - reduced by 30% (was 30)
    this.teleportDuration = 150; // ms, smooth teleport travel animation

    this.maxCooldown = 9000; // ms
    this.cooldownRemaining = 0;

    this.shadows = [];

    // 'idle' | 'awaiting_recast' - purely so the UI shows the same
    // pulsing "TELEPORT!" prompt Blade Throw/Sword Waves use whenever
    // there's a free follow-up available; tryCast itself branches on
    // this.shadows.length, not on this.phase.
    this.phase = 'idle';

    // Dash animation state (initial cast)
    this.isDashing = false;
    this.dashTimer = 0;
    this.dashFromX = 0;
    this.dashFromY = 0;
    this.dashToX = 0;
    this.dashToY = 0;

    // Teleport animation state (follow-up press)
    this.isTeleporting = false;
    this.teleportTimer = 0;
    this.teleportFromX = 0;
    this.teleportFromY = 0;
    this.teleportToX = 0;
    this.teleportToY = 0;

    // Set once a teleport begins, resolved on arrival (see update()).
    this._pendingArrivalTarget = null;
    this._pendingOnHitKill = null;
  }

  get isReady() {
    return this.cooldownRemaining <= 0 && !this.isDashing;
  }

  get isCasting() {
    return this.isDashing || this.isTeleporting;
  }

  /**
   * @param {Player} caster
   * @param {EffectSystem} effects
   * @param {(target:Object) => void} onHitKill
   * @param {Array} hostiles - unused by this skill (shadows gather
   *        their own hostiles every frame via update())
   */
  tryCast(caster, effects, onHitKill, hostiles) {
    if (caster.isDead || this.isDashing || this.isTeleporting) return false;

    // Shadows already out on the field: every press from here is a
    // teleport, never a fresh cast. If none exist, this press does
    // nothing unless the skill is off cooldown (a fresh cast).
    if (this.shadows.length > 0) {
      return this._executeTeleport(caster, effects, onHitKill);
    }

    if (!this.isReady) return false;

    this._executeCast(caster, effects);
    return true;
  }

  /**
   * Dashes the caster a short distance forward, then launches 4
   * shadows from the landing spot: one in the same forward direction,
   * one straight behind, and two perpendicular to it (left/right) -
   * computed by rotating the facing vector ±90°, so it works no
   * matter which of the 4 facing directions the caster is in.
   */
  _executeCast(caster, effects) {
    const dirVec = SKILL_DIRECTION_VECTORS[caster.direction] || SKILL_DIRECTION_VECTORS.down;

    const dest = this._clampToMap(caster, caster.x + dirVec.x * this.dashRange, caster.y + dirVec.y * this.dashRange);
    this.dashFromX = caster.x;
    this.dashFromY = caster.y;
    this.dashToX = dest.x;
    this.dashToY = dest.y;
    this.isDashing = true;
    this.dashTimer = 0;

    effects.spawnAttackEffect(this.dashFromX, this.dashFromY, this.dashToX, this.dashToY, '#7c4dff');

    const forward = dirVec;
    const backward = { x: -dirVec.x, y: -dirVec.y };
    const left = { x: -dirVec.y, y: dirVec.x };
    const right = { x: dirVec.y, y: -dirVec.x };

    this.shadows = [forward, left, right, backward].map(
      dir => new ShadowClone(dest.x, dest.y, dir, this.shadowSpeed, this.shadowRange)
    );

    effects.spawnAttackEffect(dest.x, dest.y, dest.x, dest.y, '#b388ff');

    this.cooldownRemaining = this.maxCooldown;
  }

  /**
   * Blinks the caster to whichever shadow should be prioritized -
   * the shadow in the direction the caster is currently facing. If a
   * marked shadow exists in that direction, prioritize it. Landing on
   * a marked shadow deals bonus damage to the enemy it's attached to,
   * if that enemy is still alive. The used shadow is consumed;
   * everything else stays out.
   */
  _executeTeleport(caster, effects, onHitKill) {
    if (this.shadows.length === 0) return false;

    const dirVec = SKILL_DIRECTION_VECTORS[caster.direction] || SKILL_DIRECTION_VECTORS.down;

    // Find the shadow that best matches the facing direction
    let target = null;
    let bestDot = -Infinity;

    for (const shadow of this.shadows) {
      const dot = shadow.dirX * dirVec.x + shadow.dirY * dirVec.y;
      if (dot > bestDot) {
        bestDot = dot;
        target = shadow;
      }
    }

    if (!target) return false;

    const dest = this._clampToMap(caster, target.x, target.y);

    this.teleportFromX = caster.x;
    this.teleportFromY = caster.y;
    this.teleportToX = dest.x;
    this.teleportToY = dest.y;
    this.isTeleporting = true;
    this.teleportTimer = 0;
    this._pendingArrivalTarget = target.hitApplied ? target.markedTarget : null;
    this._pendingOnHitKill = onHitKill;

    const dx = dest.x - caster.x;
    const dy = dest.y - caster.y;
    if (Math.abs(dx) > Math.abs(dy)) {
      caster.direction = dx > 0 ? 'right' : 'left';
    } else if (dy !== 0) {
      caster.direction = dy > 0 ? 'down' : 'up';
    }

    effects.spawnAttackEffect(this.teleportFromX, this.teleportFromY, this.teleportFromX, this.teleportFromY, '#7c4dff');

    // Consumed the instant it's targeted - the rest keep living and
    // counting down independently.
    this.shadows = this.shadows.filter(s => s !== target);

    return true;
  }

  /**
   * @param {Player} caster - needed to move the caster during the
   *        dash/teleport animations.
   */
  update(deltaTime, hostiles, effects, onHitKill, caster) {
    if (this.cooldownRemaining > 0) {
      this.cooldownRemaining -= deltaTime;
    }

    if (this.isDashing) {
      this.dashTimer += deltaTime;
      const t = Math.min(1, this.dashTimer / this.dashDuration);
      caster.x = this.dashFromX + (this.dashToX - this.dashFromX) * t;
      caster.y = this.dashFromY + (this.dashToY - this.dashFromY) * t;
      if (t >= 1) this.isDashing = false;
    }

    if (this.isTeleporting) {
      this.teleportTimer += deltaTime;
      const t = Math.min(1, this.teleportTimer / this.teleportDuration);
      caster.x = this.teleportFromX + (this.teleportToX - this.teleportFromX) * t;
      caster.y = this.teleportFromY + (this.teleportToY - this.teleportFromY) * t;
      if (t >= 1) {
        this.isTeleporting = false;

        if (this._pendingArrivalTarget && this._pendingArrivalTarget.hp > 0) {
          const killed = Combat.applyDamage(this._pendingArrivalTarget, this.teleportBonusDamage);
          effects.spawnAttackEffect(caster.x, caster.y, this._pendingArrivalTarget.x, this._pendingArrivalTarget.y, '#ff5252');
          if (killed && this._pendingOnHitKill) this._pendingOnHitKill(this._pendingArrivalTarget);
        } else {
          effects.spawnAttackEffect(caster.x, caster.y, caster.x, caster.y, '#b388ff');
        }
        this._pendingArrivalTarget = null;
        this._pendingOnHitKill = null;
      }
    }

    // A hero already carrying a shadow cannot be marked by another clone.
    // Seed the set from existing attachments, then extend it as each clone
    // resolves this frame so simultaneous contact still yields one mark.
    const attachedHeroes = new Set(
      this.shadows
        .filter(shadow => shadow.hitApplied && shadow.markedTarget && shadow.markedTarget.hp > 0)
        .map(shadow => shadow.markedTarget)
    );
    for (const shadow of this.shadows) {
      shadow.update(deltaTime, hostiles, effects, onHitKill,
        this.hitDamage, this.slowMultiplier, this.slowDuration, attachedHeroes);
      if (shadow.hitApplied && shadow.markedTarget && shadow.markedTarget.hp > 0) {
        attachedHeroes.add(shadow.markedTarget);
      }
    }
    this.shadows = this.shadows.filter(s => s.phase !== 'expired');

    // UI-only bookkeeping - see the constructor note on this.phase.
    this.phase = this.shadows.length > 0 ? 'awaiting_recast' : 'idle';
  }

  draw(ctx, camera) {
    for (const shadow of this.shadows) {
      shadow.draw(ctx, camera);
    }
  }

  /**
   * Shared helper: clamps a world point to stay inside the map,
   * using the caster's own collision box - same approach the
   * ultimate uses for its blink destination.
   */
  _clampToMap(caster, x, y) {
    if (caster.mapBounds) {
      const halfWidth = (caster.collisionWidth || 28) / 2;
      const halfHeight = (caster.collisionHeight || 20) / 2;
      return Collision.clampToMap(x, y, halfWidth, halfHeight, caster.mapBounds);
    }
    return { x, y };
  }

  /**
   * Returns this slot to a fresh, immediately-castable state. Any
   * shadows already out are left alone rather than wiped - same
   * convention as Sword Waves' reset() - so a cooldown refresh from
   * the ultimate doesn't erase battlefield state the player already
   * earned.
   */
  reset() {
    this.cooldownRemaining = 0;
    this.isDashing = false;
    return null;
  }
}

/**
 * ShadowKillSkill (Skill slot 3, "Shadow Kill", Hayabusa)
 * ------------------------------------------------------
 * A single-activation ultimate, state-machine style:
 *
 *   idle --(cast, valid target in range)--> dashing to nearest target,
 *   untargetable --(arrives)--> slashing (fast hits spread across
 *   every target in range) --(last slash lands)--> returning to the
 *   spot the caster activated from --(arrives)--> idle (untargetable
 *   ends, cooldown starts)
 *
 * Enemy heroes are always preferred: if any are in range, minions/
 * jungle monsters are ignored entirely for this cast; they're only
 * used as a fallback when no hero is in range.
 * ------------------------------------------------------
 */
/**
 * AlectoFinalBlowSkill (Skill slot 3, Benedetta only)
 * ------------------------------------------------------
 * A committed 0.5 second wind-up followed by a long, invulnerable
 * sword dash.  Every enemy crossed by the dash is cut once; its path
 * then remains as a three-second sword trail which ticks damage and a
 * 50% slow every 0.3 seconds.  The trail is deliberately not a casting
 * state: Benedetta regains normal movement as soon as she lands.
 * ------------------------------------------------------
 */
class AlectoFinalBlowSkill {
  constructor() {
    this.slot = 3;
    this.name = 'Alecto: Final Blow';
    this.locked = false;
    this.recastLabel = null;

    this.windupDuration = 400;
    this.dashDuration = 70;
    this.dashRange = 420;
    this.dashDamage = 42;
    this.trailDamage = 12;
    this.trailDuration = 3000;
    this.damageInterval = 300;
    this.slowMultiplier = 0.5;
    this.trailHalfWidth = 42;
    this.maxCooldown = 18000;
    this.cooldownRemaining = 0;

    // 'idle' | 'windup' | 'dashing' | 'trail'
    this.phase = 'idle';
    this.phaseTimer = 0;
    this.fromX = 0;
    this.fromY = 0;
    this.toX = 0;
    this.toY = 0;
    this.dirX = 0;
    this.dirY = 1;
    this.dashHitTargets = new Set();
    this.afterimages = [];
    this.afterimageTimer = 0;
    this._activeCaster = null;
    this.trailLife = 0;
    this.damageTimer = 0;
    this.slashTimer = 0;
  }

  get isReady() {
    return this.phase === 'idle' && this.cooldownRemaining <= 0;
  }

  // Only the wind-up and dash consume player control.  The ground
  // trail remains active afterwards without blocking movement/input.
  get isCasting() {
    return this.phase === 'windup' || this.phase === 'dashing';
  }

  tryCast(caster, effects, onHitKill, hostiles) {
    if (caster.isDead || !this.isReady) return false;

    const dir = SKILL_DIRECTION_VECTORS[caster.direction] || SKILL_DIRECTION_VECTORS.down;
    this.fromX = caster.x;
    this.fromY = caster.y;
    this.dirX = dir.x;
    this.dirY = dir.y;
    const destination = this._resolveDestination(caster);
    this.toX = destination.x;
    this.toY = destination.y;
    this.phase = 'windup';
    this.phaseTimer = 0;
    this.dashHitTargets.clear();
    this.afterimages = [];
    this.afterimageTimer = 0;
    this._activeCaster = caster;
    caster.isMovementLocked = true;
    // Casting Alecto: Final Blow immediately fully charges Benedetta's
    // passive bar, ready for her next Elapsed Daytime dash.
    if (caster.character === 'benedetta') caster.energy = caster.maxEnergy;
    effects.spawnAttackEffect(this.fromX, this.fromY, this.fromX, this.fromY, '#133f05');
    return true;
  }

  update(deltaTime, hostiles, effects, onHitKill, caster) {
    if (this.cooldownRemaining > 0) this.cooldownRemaining -= deltaTime;
    for (const image of this.afterimages) image.life -= deltaTime;
    this.afterimages = this.afterimages.filter(image => image.life > 0);

    if (this.phase === 'windup') {
      this.phaseTimer += deltaTime;
      if (this.phaseTimer >= this.windupDuration) {
        this.phase = 'dashing';
        this.phaseTimer = 0;
        caster.isUntargetable = true;
        this._spawnAfterimage(this.fromX, this.fromY);
        effects.spawnAttackEffect(this.fromX, this.fromY, this.toX, this.toY, '#057010');
      }
      return;
    }

    if (this.phase === 'dashing') {
      this.phaseTimer += deltaTime;
      const progress = Math.min(1, this.phaseTimer / this.dashDuration);
      caster.x = this.fromX + (this.toX - this.fromX) * progress;
      caster.y = this.fromY + (this.toY - this.fromY) * progress;

      this.afterimageTimer += deltaTime;
      while (this.afterimageTimer >= 55) {
        this.afterimageTimer -= 55;
        this._spawnAfterimage(caster.x, caster.y);
        effects.spawnAttackEffect(caster.x - this.dirX * 28, caster.y - this.dirY * 28,
          caster.x + this.dirX * 28, caster.y + this.dirY * 28, '#043505');
      }
      this._damageDashTargets(hostiles, effects, onHitKill, caster.x, caster.y, caster);

      if (progress >= 1) {
        caster.x = this.toX;
        caster.y = this.toY;
        caster.isUntargetable = false;
        caster.isMovementLocked = false;
        this._activeCaster = null;
        this.phase = 'trail';
        this.trailLife = this.trailDuration;
        this.damageTimer = 0;
        this.slashTimer = 0;
        // The dash itself is complete, so this is when the ultimate cooldown begins.
        this.cooldownRemaining = this.maxCooldown;
        effects.spawnAttackEffect(this.fromX, this.fromY, this.toX, this.toY, '#085408');
      }
      return;
    }

    if (this.phase === 'trail') {
      this.trailLife -= deltaTime;
      this.slashTimer += deltaTime;
      this.damageTimer += deltaTime;
      this._applyTrailSlow(hostiles);
      while (this.damageTimer >= this.damageInterval && this.trailLife > 0) {
        this.damageTimer -= this.damageInterval;
        this._damageTrailTargets(hostiles, effects, onHitKill, caster);
      }
      if (this.trailLife <= 0) this.phase = 'idle';
    }
  }

  _resolveDestination(caster) {
    let x = caster.x + this.dirX * this.dashRange;
    let y = caster.y + this.dirY * this.dashRange;
    if (caster.mapBounds) {
      const clamped = Collision.clampToMap(x, y, (caster.collisionWidth || 28) / 2,
        (caster.collisionHeight || 20) / 2, caster.mapBounds);
      x = clamped.x;
      y = clamped.y;
    }
    return { x, y };
  }

  _damageDashTargets(hostiles, effects, onHitKill, x, y, caster) {
    for (const target of hostiles) {
      if (!target || target.hp <= 0 || this.dashHitTargets.has(target)) continue;
      const radius = (target.drawWidth || 40) / 2;
      if (Combat.distance(x, y, target.x, target.y) <= radius + 28) {
        this.dashHitTargets.add(target);
        const killed = Combat.applyDamage(target, this.dashDamage, caster);
        effects.spawnAttackEffect(x, y, target.x, target.y, '#064a09');
        if (killed && onHitKill) onHitKill(target);
      }
    }
  }

  _isInTrail(target) {
    const lineX = this.toX - this.fromX;
    const lineY = this.toY - this.fromY;
    const lengthSquared = lineX * lineX + lineY * lineY;
    if (lengthSquared === 0) return false;
    const projected = ((target.x - this.fromX) * lineX + (target.y - this.fromY) * lineY) / lengthSquared;
    if (projected < 0 || projected > 1) return false;
    const nearestX = this.fromX + lineX * projected;
    const nearestY = this.fromY + lineY * projected;
    const radius = (target.drawWidth || 40) / 2;
    return Combat.distance(target.x, target.y, nearestX, nearestY) <= this.trailHalfWidth + radius;
  }

  _applyTrailSlow(hostiles) {
    for (const target of hostiles) {
      if (target && target.hp > 0 && this._isInTrail(target)) {
        Combat.applySlow(target, this.slowMultiplier, this.damageInterval + 100);
      }
    }
  }

  _damageTrailTargets(hostiles, effects, onHitKill, caster) {
    for (const target of hostiles) {
      if (!target || target.hp <= 0 || !this._isInTrail(target)) continue;
      const killed = Combat.applyDamage(target, this.trailDamage, caster);
      effects.spawnAttackEffect(this.fromX, this.fromY, target.x, target.y, '#075b12');
      if (killed && onHitKill) onHitKill(target);
    }
  }

  _spawnAfterimage(x, y) {
    this.afterimages.push({ x, y, life: 240, maxLife: 240 });
  }

  draw(ctx, camera) {
    // Blade-shaped afterimages make the high-speed dash readable.
    for (const image of this.afterimages) {
      const sx = camera.worldToScreenX(image.x);
      const sy = camera.worldToScreenY(image.y);
      ctx.save();
      ctx.globalAlpha = (image.life / image.maxLife) * 0.45;
      ctx.fillStyle = '#0f5803';
      ctx.beginPath();
      ctx.ellipse(sx, sy, 18, 26, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    if (this.phase !== 'trail') return;
    const startX = camera.worldToScreenX(this.fromX);
    const startY = camera.worldToScreenY(this.fromY);
    const endX = camera.worldToScreenX(this.toX);
    const endY = camera.worldToScreenY(this.toY);
    const alpha = Math.max(0, this.trailLife / this.trailDuration);
    const angle = Math.atan2(endY - startY, endX - startX);
    const length = Math.hypot(endX - startX, endY - startY);

    ctx.save();
    ctx.globalAlpha = 0.32 + alpha * 0.38;
    ctx.strokeStyle = '#034c20';
    ctx.lineWidth = this.trailHalfWidth * 2;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(endX, endY);
    ctx.stroke();
    ctx.globalAlpha = 0.8 * alpha;
    ctx.strokeStyle = '#035206';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(endX, endY);
    ctx.stroke();

    // Repeating diagonal cuts form the requested multiple-slash effect inside the trail.
    ctx.translate(startX, startY);
    ctx.rotate(angle);
    ctx.strokeStyle = '#08260e';
    ctx.lineWidth = 2;
    for (let x = 40; x < length - 10; x += 58) {
      const pulse = Math.sin((this.slashTimer / 75) + x) * 5;
      ctx.beginPath();
      ctx.moveTo(x - 13, -this.trailHalfWidth + 10 + pulse);
      ctx.lineTo(x + 13, this.trailHalfWidth - 10 + pulse);
      ctx.stroke();
    }
    ctx.restore();
  }

  reset() {
    if (this._activeCaster) {
      this._activeCaster.isUntargetable = false;
      this._activeCaster.isMovementLocked = false;
    }
    this.phase = 'idle';
    this.phaseTimer = 0;
    this.trailLife = 0;
    this.damageTimer = 0;
    this.slashTimer = 0;
    this.dashHitTargets.clear();
    this.afterimages = [];
    this._activeCaster = null;
    return null;
  }
}

class ShadowKillSkill {
  constructor() {
    this.slot = 3;
    this.name = 'Shadow Kill';
    this.locked = false;
    this.recastLabel = null; // single activation - no recast window

    this.range = 130; // search radius for a valid target on activation (matches basic attack range)
    this.slashCount = 10; // total slashes dealt across the whole target pool - increased
    this.heroDamage = 8; // Physical Damage per slash vs heroes - reduced by 10% (was 13)
    this.creepDamage = 20; // Physical Damage per slash vs creeps - increased by 40% (was 13)
    this.slashInterval = 90; // ms between each slash - fast flurry
    this.slashRadius = 50; // px the caster stands off from a target while slashing it
    this.dashDuration = 125; // ms, the initial dash to the nearest target
    this.returnDuration = 150; // ms, the dash back to the activation point

    this.maxCooldown = 20000; // ms - only starts once the whole animation resolves
    this.cooldownRemaining = 0;

    // 'idle' | 'dashing' | 'slashing' | 'returning'
    this.phase = 'idle';

    // Dash-in animation state
    this.dashTimer = 0;
    this.dashFromX = 0;
    this.dashFromY = 0;
    this.dashToX = 0;
    this.dashToY = 0;

    // Slash sequence state
    this.activeTargets = [];
    this.slashesLanded = 0;
    this.slashTimer = 0;
    this._onHitKill = null;

    // Return-dash animation state
    this.returnTimer = 0;
    this.returnFromX = 0;
    this.returnFromY = 0;
    this.returnToX = 0;
    this.returnToY = 0;

    // Afterimages dropped at every blink point during the flurry -
    // purely cosmetic, self-expiring.
    this.afterimages = []; // each: { x, y, life, maxLife }
  }

  get isReady() {
    return this.phase === 'idle' && this.cooldownRemaining <= 0;
  }

  get isCasting() {
    return this.phase !== 'idle';
  }

  /**
   * Builds the valid target pool for a cast: every living, targetable
   * hostile within range. Enemy heroes are strictly preferred - if
   * any are in range, minions/jungle monsters are dropped from the
   * pool entirely; they only surface when no hero is in range.
   */
  _findTargetPool(caster, hostiles) {
    const inRange = hostiles.filter(h => h && h.hp > 0 && !h.isUntargetable &&
      Combat.distance(caster.x, caster.y, h.x, h.y) <= this.range);

    if (inRange.length === 0) return [];

    const heroes = inRange.filter(h => !(h instanceof Creep));
    return heroes.length > 0 ? heroes : inRange;
  }

  /**
   * @param {Player} caster
   * @param {EffectSystem} effects
   * @param {(target:Object) => void} onHitKill
   * @param {Array} hostiles - every hostile currently valid to target,
   *        used to find who's in range right now.
   */
  tryCast(caster, effects, onHitKill, hostiles) {
    if (caster.isDead || !this.isReady) return false;

    const targets = this._findTargetPool(caster, hostiles);
    if (targets.length === 0) return false; // no valid target within range

    // Nearest target in the chosen pool is the initial dash-in point.
    let primary = targets[0];
    let bestDist = Combat.distance(caster.x, caster.y, primary.x, primary.y);
    for (const t of targets) {
      const d = Combat.distance(caster.x, caster.y, t.x, t.y);
      if (d < bestDist) {
        bestDist = d;
        primary = t;
      }
    }

    this.activeTargets = targets;
    this._onHitKill = onHitKill;
    this.slashesLanded = 0;
    this.slashTimer = 0;

    // Remember the activation point - the caster returns here once
    // the whole flurry resolves.
    this.returnToX = caster.x;
    this.returnToY = caster.y;

    // Untargetable for the entire duration of the ultimate.
    caster.isUntargetable = true;

    this.dashFromX = caster.x;
    this.dashFromY = caster.y;
    this.dashToX = primary.x;
    this.dashToY = primary.y;
    this.dashTimer = 0;
    this.phase = 'dashing';

    this._faceToward(caster, this.dashToX, this.dashToY);
    this._spawnAfterimage(this.dashFromX, this.dashFromY);
    effects.spawnAttackEffect(this.dashFromX, this.dashFromY, this.dashToX, this.dashToY, '#ea480d');

    return true;
  }

  /**
   * @param {Player} caster - moved directly by every phase of this skill.
   */
  update(deltaTime, hostiles, effects, onHitKill, caster) {
    if (this.cooldownRemaining > 0) {
      this.cooldownRemaining -= deltaTime;
    }

    for (const img of this.afterimages) img.life -= deltaTime;
    this.afterimages = this.afterimages.filter(img => img.life > 0);

    if (this.phase === 'dashing') {
      this.dashTimer += deltaTime;
      const t = Math.min(1, this.dashTimer / this.dashDuration);
      caster.x = this.dashFromX + (this.dashToX - this.dashFromX) * t;
      caster.y = this.dashFromY + (this.dashToY - this.dashFromY) * t;
      if (t >= 1) {
        this.phase = 'slashing';
        this.slashTimer = this.slashInterval; // land the first slash right away
      }
      return;
    }

    if (this.phase === 'slashing') {
      this.slashTimer += deltaTime;
      // A while-loop (not an if) so a slow frame can't skip slashes -
      // it just lands however many were due since the last frame.
      while (this.slashTimer >= this.slashInterval && this.slashesLanded < this.slashCount) {
        this.slashTimer -= this.slashInterval;
        this._landSlash(caster, effects);
      }

      if (this.slashesLanded >= this.slashCount) {
        // Don't return to start - stay where the last slash landed
        caster.isUntargetable = false;
        this.activeTargets = [];
        this._onHitKill = null;
        this.phase = 'idle';
        // The animation is fully over - the cooldown starts now.
        this.cooldownRemaining = this.maxCooldown;
      }
      return;
    }

    // Returning phase removed - player stays at final slash position
  }

  /**
   * Lands a single slash: blinks the caster to a point just off the
   * assigned target (round-robin across the target pool, so a single
   * target takes every slash while a full pool spreads them out),
   * deals damage, and leaves an afterimage + slash flash behind.
   * A target that died mid-flurry is simply skipped - the slash still
   * counts toward the total so the flurry doesn't run long either way.
   */
  _landSlash(caster, effects) {
    const target = this.activeTargets[this.slashesLanded % this.activeTargets.length];
    this.slashesLanded++;

    if (!target || target.hp <= 0) return;

    // Circle around the target rather than stacking directly on top
    // of it, so the flurry reads as slashes "around" them.
    const angle = (this.slashesLanded / this.slashCount) * Math.PI * 4 + Math.random() * 0.6;
    caster.x = target.x + Math.cos(angle) * this.slashRadius;
    caster.y = target.y + Math.sin(angle) * this.slashRadius;

    this._faceToward(caster, target.x, target.y);
    this._spawnAfterimage(caster.x, caster.y);

    // Use different damage values for heroes vs creeps
    const damage = target instanceof Creep ? this.creepDamage : this.heroDamage;
    const killed = Combat.applyDamage(target, damage);
    effects.spawnAttackEffect(caster.x, caster.y, target.x, target.y, '#360b00');
    if (killed && this._onHitKill) this._onHitKill(target);
  }

  _faceToward(caster, tx, ty) {
    const dx = tx - caster.x;
    const dy = ty - caster.y;
    if (Math.abs(dx) > Math.abs(dy)) {
      caster.direction = dx > 0 ? 'right' : 'left';
    } else if (dy !== 0) {
      caster.direction = dy > 0 ? 'down' : 'up';
    }
  }

  _spawnAfterimage(x, y) {
    this.afterimages.push({ x, y, life: 220, maxLife: 220 });
  }

  /**
   * Draws the fading afterimage trail left behind by the dash and
   * every slash - the flurry's core "fast, everywhere at once" look.
   */
  draw(ctx, camera) {
    for (const img of this.afterimages) {
      const alpha = Math.max(0, img.life / img.maxLife) * 0.45;
      const sx = camera.worldToScreenX(img.x);
      const sy = camera.worldToScreenY(img.y);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#d53c05';
      ctx.beginPath();
      ctx.ellipse(sx, sy, 16, 24, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  /**
   * Interface parity with the other skills - Shadow Kill isn't reset
   * by anything else right now (it doesn't sit in any sibling-reset
   * chain the way Skills 1/2 do for Gusion's ultimate), but keeping
   * this here means it's ready to slot into one later.
   */
  reset() {
    return null;
  }
}

/**
 * Chou: Jeet Kune Do (Skill 1)
 * ------------------------------------------------------
 * A 3-hit combo, castable up to 3 times within a 5-second window:
 *   Hit 1 & Hit 2 - a short forward dash into a quick punch, damaging
 *                   every enemy in a cone in front of Chou.
 *   Hit 3         - a short forward dash followed by a powerful
 *                   uppercut: extra damage, knocks enemies airborne
 *                   for 1 second (also briefly interrupting their
 *                   actions - implemented as a stun), and finishes
 *                   with a much stronger impact effect.
 * If the next hit isn't thrown before the 5s window runs out, the
 * combo resets back to hit 1. The full cooldown only starts once
 * hit 3 lands (dash finished) OR the combo window expires early.
 * ------------------------------------------------------
 */
class JeetKuneDoSkill {
  constructor() {
    this.slot = 1;
    this.name = 'Jeet Kune Do';
    this.locked = false;

    this.maxCooldown = 5000; // ms, applied once the combo finishes/resets
    this.cooldownRemaining = 0;

    this.comboStep = 0; // 0 = ready for hit 1; 1/2 = waiting on the next press
    this.comboTimer = 0;
    this.comboWindow = 5000; // ms - "within 5 seconds"

    // Hits 1 & 2: identical quick forward dash into a punch.
    this.punchDashDistance = 75;
    this.punchDashDuration = 90;
    this.punchDashDamage = 22;
    this.punchDashHitRadius = 34;
    this.punchRange = 90;
    this.punchHalfAngle = Math.PI / 4; // 45 degrees each side = 90-degree "in front" cone
    this.punchDamage = 18;

    // Hit 3: forward dash, then a powerful uppercut on arrival.
    this.dashDistance = 85;
    this.dashDuration = 150; // ms - "quick"
    this.uppercutRange = 80;
    this.uppercutDamage = 27;
    this.airborneDuration = 500; // ms - "knocks enemies airborne for 1 second"

    // 'idle' | 'dashing'. All three hits use a brief movement phase;
    // dashKind tells the update whether to land a punch or uppercut.
    this.phase = 'idle';
    this.dashKind = null;
    this.pendingStep = 0;
    this.dashTimer = 0;
    this.dirVec = SKILL_DIRECTION_VECTORS.down;
    this.dashFromX = 0;
    this.dashFromY = 0;
    this.dashToX = 0;
    this.dashToY = 0;
    this.pendingHostiles = null;
    this.pendingOnHitKill = null;
    this.dashHitTargets = new Set();

    // Visuals: a short-lived burst per cast (bigger + brighter on hit
    // 3), plus afterimages while the dash is moving.
    this.bursts = [];
    this.afterimages = [];
    this.afterimageTimer = 0;
  }

  get isReady() {
    return this.phase === 'idle' && this.cooldownRemaining <= 0;
  }

  get isCasting() {
    return this.phase === 'dashing';
  }

  /**
   * @param {Player} caster
   * @param {EffectSystem} effects
   * @param {(target:Object) => void} onHitKill
   * @param {Array} hostiles
   */
  tryCast(caster, effects, onHitKill, hostiles) {
    if (caster.isDead) return false;
    if (!this.isReady) return false;

    this.comboStep++;
    this.comboTimer = this.comboWindow;

    const dirVec = SKILL_DIRECTION_VECTORS[caster.direction] || SKILL_DIRECTION_VECTORS.down;

    if (this.comboStep < 3) {
      this._beginPunchDash(caster, dirVec, hostiles, onHitKill, this.comboStep);
    } else {
      this._beginDash(caster, dirVec, hostiles, onHitKill);
    }
    return true;
  }

  /**
   * Lands one of the first two punches after its short dash finishes.
   */
  _forwardPunch(caster, dirVec, effects, onHitKill, hostiles, step) {
    for (const target of hostiles) {
      if (!target || target.hp <= 0) continue;
      if (!this._isInFrontCone(caster, dirVec, target, this.punchRange, this.punchHalfAngle)) continue;

      const killed = Combat.applyDamage(target, this.punchDamage);
      effects.spawnAttackEffect(caster.x, caster.y, target.x, target.y, step === 1 ? '#ffab91' : '#ff7043');
      if (killed && onHitKill) onHitKill(target);
    }

    // A small burst out in front, slightly bigger/brighter on hit 2 so
    // the two punches still read as distinct beats.
    this.bursts.push({
      x: caster.x + dirVec.x * 40,
      y: caster.y + dirVec.y * 40,
      radius: step === 1 ? 24 : 30,
      life: 200,
      maxLife: 200,
      color: step === 1 ? '#ffab91' : '#ff7043',
      strong: false
    });
  }

  /** Starts the short lunge used by combo phases 1 and 2. */
  _beginPunchDash(caster, dirVec, hostiles, onHitKill, step) {
    this.dirVec = dirVec;
    this.dashFromX = caster.x;
    this.dashFromY = caster.y;
    let destX = caster.x + dirVec.x * this.punchDashDistance;
    let destY = caster.y + dirVec.y * this.punchDashDistance;
    if (caster.mapBounds) {
      const clamped = Collision.clampToMap(destX, destY, (caster.collisionWidth || 28) / 2, (caster.collisionHeight || 20) / 2, caster.mapBounds);
      destX = clamped.x;
      destY = clamped.y;
    }
    this.dashToX = destX;
    this.dashToY = destY;
    this.dashTimer = 0;
    this.phase = 'dashing';
    this.dashKind = 'punch';
    this.pendingStep = step;
    this.pendingHostiles = hostiles;
    this.pendingOnHitKill = onHitKill;
    this.dashHitTargets.clear();
    caster.isMovementLocked = true;
  }

  /**
   * Hit 3: starts the forward dash. The uppercut itself resolves once
   * the dash arrives (see update()), not immediately on press.
   */
  _beginDash(caster, dirVec, hostiles, onHitKill) {
    this.dirVec = dirVec;
    this.dashFromX = caster.x;
    this.dashFromY = caster.y;

    let destX = this.dashFromX + dirVec.x * this.dashDistance;
    let destY = this.dashFromY + dirVec.y * this.dashDistance;

    if (caster.mapBounds) {
      const halfWidth = (caster.collisionWidth || 28) / 2;
      const halfHeight = (caster.collisionHeight || 20) / 2;
      const clamped = Collision.clampToMap(destX, destY, halfWidth, halfHeight, caster.mapBounds);
      destX = clamped.x;
      destY = clamped.y;
    }

    this.dashToX = destX;
    this.dashToY = destY;
    this.phase = 'dashing';
    this.dashKind = 'uppercut';
    this.dashTimer = 0;
    this.afterimageTimer = 0;
    this.pendingHostiles = hostiles;
    this.pendingOnHitKill = onHitKill;
    caster.isMovementLocked = true;
  }

  update(deltaTime, hostiles, effects, onHitKill, caster) {
    if (this.cooldownRemaining > 0) {
      this.cooldownRemaining -= deltaTime;
    }

    for (const b of this.bursts) b.life -= deltaTime;
    this.bursts = this.bursts.filter(b => b.life > 0);
    for (const img of this.afterimages) img.life -= deltaTime;
    this.afterimages = this.afterimages.filter(img => img.life > 0);

    if (this.phase === 'dashing') {
      this.dashTimer += deltaTime;
      const duration = this.dashKind === 'punch' ? this.punchDashDuration : this.dashDuration;
      const t = Math.min(1, this.dashTimer / duration);
      const previousX = caster.x;
      const previousY = caster.y;
      caster.x = this.dashFromX + (this.dashToX - this.dashFromX) * t;
      caster.y = this.dashFromY + (this.dashToY - this.dashFromY) * t;

      if (this.dashKind === 'punch') {
        this._damagePunchDash(caster, previousX, previousY, effects, onHitKill || this.pendingOnHitKill, hostiles || this.pendingHostiles);
      }

      this.afterimageTimer -= deltaTime;
      if (this.afterimageTimer <= 0) {
        this.afterimages.push({ x: caster.x, y: caster.y, life: 180, maxLife: 180 });
        this.afterimageTimer = 20;
      }

      if (t >= 1) {
        if (this.dashKind === 'punch') {
          this._forwardPunch(caster, this.dirVec, effects, onHitKill || this.pendingOnHitKill, hostiles || this.pendingHostiles, this.pendingStep);
        } else {
          this._resolveUppercut(caster, effects, onHitKill || this.pendingOnHitKill, hostiles || this.pendingHostiles);
        }
        this.phase = 'idle';
        this.dashKind = null;
        this.pendingStep = 0;
        this.pendingHostiles = null;
        this.pendingOnHitKill = null;
        caster.isMovementLocked = false;
      }
      return;
    }

    // Combo-window countdown, only relevant while waiting on the next press.
    if (this.comboStep > 0) {
      this.comboTimer -= deltaTime;
      if (this.comboTimer <= 0) {
        this.comboStep = 0;
        this.comboTimer = 0;
        this.cooldownRemaining = this.maxCooldown;
      }
    }
  }

  /** Every target Chou passes through during phases 1/2 is struck once. */
  _damagePunchDash(caster, fromX, fromY, effects, onHitKill, hostiles) {
    for (const target of hostiles || []) {
      if (!target || target.hp <= 0 || this.dashHitTargets.has(target)) continue;
      const targetRadius = (target.drawWidth || 40) / 2;
      const segmentX = caster.x - fromX;
      const segmentY = caster.y - fromY;
      const segmentLengthSq = segmentX * segmentX + segmentY * segmentY;
      const projection = segmentLengthSq === 0 ? 0 : Math.max(0, Math.min(1,
        ((target.x - fromX) * segmentX + (target.y - fromY) * segmentY) / segmentLengthSq
      ));
      const closestX = fromX + segmentX * projection;
      const closestY = fromY + segmentY * projection;
      if (Combat.distance(closestX, closestY, target.x, target.y) > this.punchDashHitRadius + targetRadius) continue;
      this.dashHitTargets.add(target);
      const killed = Combat.applyDamage(target, this.punchDashDamage);
      effects.spawnAttackEffect(caster.x, caster.y, target.x, target.y, '#ff8a65');
      if (killed && onHitKill) onHitKill(target);
    }
  }

  /**
   * Resolves the uppercut once the dash has arrived: damage, a 1s
   * airborne stun, and the strongest impact burst of the combo.
   */
  _resolveUppercut(caster, effects, onHitKill, hostiles) {
    let hitTarget = false;
    for (const target of hostiles || []) {
      if (!target || target.hp <= 0) continue;
      const targetRadius = target.drawWidth ? target.drawWidth / 2 : 20;
      if (Combat.distance(caster.x, caster.y, target.x, target.y) > this.uppercutRange + targetRadius) continue;

      const killed = Combat.applyDamage(target, this.uppercutDamage);
      Combat.applyAirborne(target, this.airborneDuration);
      hitTarget = true;
      effects.spawnAttackEffect(caster.x, caster.y, target.x, target.y, '#ffca28');
      if (killed && onHitKill) onHitKill(target);
    }

    this.bursts.push({ x: caster.x, y: caster.y, radius: 60, life: 320, maxLife: 320, color: '#ffca28', strong: true });

    this.comboStep = 0;
    this.comboTimer = 0;
    this.cooldownRemaining = this.maxCooldown;

    // Connecting the final Jeet Kune Do hit refreshes Shunpo, but
    // only its cooldown - it never cancels a dash already underway.
    if (hitTarget && this.shunpoSkill) this.shunpoSkill.refreshCooldown();
  }

  /**
   * True if target is within `range` of caster AND inside the facing
   * cone (`halfAngle` on either side of caster's current direction).
   */
  _isInFrontCone(caster, dirVec, target, range, halfAngle) {
    const dx = target.x - caster.x;
    const dy = target.y - caster.y;
    const targetRadius = target.drawWidth ? target.drawWidth / 2 : 20;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > range + targetRadius) return false;
    if (dist < 1) return true;

    const targetAngle = Math.atan2(dy, dx);
    const centerAngle = Math.atan2(dirVec.y, dirVec.x);
    let diff = Math.abs(targetAngle - centerAngle);
    if (diff > Math.PI) diff = Math.PI * 2 - diff;
    return diff <= halfAngle;
  }

  draw(ctx, camera) {
    for (const img of this.afterimages) {
      const alpha = Math.max(0, img.life / img.maxLife) * 0.4;
      const sx = camera.worldToScreenX(img.x);
      const sy = camera.worldToScreenY(img.y);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#ffca28';
      ctx.beginPath();
      ctx.ellipse(sx, sy, 16, 24, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    for (const b of this.bursts) {
      const alpha = Math.max(0, b.life / b.maxLife);
      const sx = camera.worldToScreenX(b.x);
      const sy = camera.worldToScreenY(b.y);
      const r = b.radius * (1 - alpha) + (b.strong ? 14 : 6);

      ctx.save();
      ctx.globalAlpha = alpha * (b.strong ? 0.9 : 0.6);
      ctx.strokeStyle = b.color;
      ctx.lineWidth = b.strong ? 5 : 3;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.stroke();

      if (b.strong) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(sx, sy, r * 0.6, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  reset() {
    this.phase = 'idle';
    this.comboStep = 0;
    this.comboTimer = 0;
    this.cooldownRemaining = 0;
    this.dashTimer = 0;
    this.dashKind = null;
    this.pendingStep = 0;
    this.pendingHostiles = null;
    this.pendingOnHitKill = null;
    this.dashHitTargets.clear();
    return null;
  }
}

/** Chou: Shunpo (Skill 2) - CC-immune dash that ends in a temporary shield. */
class ShunpoSkill {
  constructor() {
    this.slot = 2;
    this.name = 'Shunpo';
    this.locked = false;
    this.maxCooldown = 6500;
    this.cooldownRemaining = 0;
    this.dashRange = 100;
    this.dashDuration = 110;
    this.shieldPercentMaxHp = 0.25;
    this.shieldDuration = 2000;
    this.isDashing = false;
    this.dashTimer = 0;
    this.fromX = 0;
    this.fromY = 0;
    this.toX = 0;
    this.toY = 0;
    this.afterimages = [];
    this.afterimageTimer = 0;
    this._dashCaster = null;
  }

  get isReady() { return this.cooldownRemaining <= 0 && !this.isDashing; }
  get isCasting() { return this.isDashing; }

  tryCast(caster, effects) {
    // Shunpo cannot break an existing crowd-control effect, but once
    // underway it ignores all further slows, stuns, and knock-ups.
    if (caster.isDead || caster.isStunned || !this.isReady) return false;
    let direction = SKILL_DIRECTION_VECTORS[caster.direction] || SKILL_DIRECTION_VECTORS.down;
    if (caster instanceof Player) {
      const movement = inputHandler.getMovementVector();
      if (movement.x !== 0 || movement.y !== 0) direction = movement;
    } else if (caster.isRemoteControlled && caster.remoteInput) {
      // A remote (guest-controlled) hero has no local inputHandler to
      // read - use the same movement vector its network input drives,
      // so its dash direction is just as responsive as the host's.
      const movement = { x: caster.remoteInput.moveX || 0, y: caster.remoteInput.moveY || 0 };
      if (movement.x !== 0 || movement.y !== 0) direction = movement;
    }
    this.fromX = caster.x;
    this.fromY = caster.y;
    let x = caster.x + direction.x * this.dashRange;
    let y = caster.y + direction.y * this.dashRange;
    if (caster.mapBounds) {
      const clamped = Collision.clampToMap(x, y, (caster.collisionWidth || 28) / 2, (caster.collisionHeight || 20) / 2, caster.mapBounds);
      x = clamped.x;
      y = clamped.y;
    }
    this.toX = x;
    this.toY = y;
    this.dashTimer = 0;
    this.isDashing = true;
    this.afterimages = [];
    this.afterimageTimer = 0;
    this._dashCaster = caster;
    caster.isMovementLocked = true;
    caster.isCrowdControlImmune = true;
    effects.spawnAttackEffect(this.fromX, this.fromY, this.toX, this.toY, '#ffb74d');
    return true;
  }

  update(deltaTime, hostiles, effects, onHitKill, caster) {
    if (this.cooldownRemaining > 0) this.cooldownRemaining -= deltaTime;
    for (const image of this.afterimages) image.life -= deltaTime;
    this.afterimages = this.afterimages.filter(image => image.life > 0);
    if (!this.isDashing) return;
    this.dashTimer += deltaTime;
    const t = Math.min(1, this.dashTimer / this.dashDuration);
    caster.x = this.fromX + (this.toX - this.fromX) * t;
    caster.y = this.fromY + (this.toY - this.fromY) * t;
    this.afterimageTimer -= deltaTime;
    if (this.afterimageTimer <= 0) {
      this.afterimages.push({ x: caster.x, y: caster.y, life: 180, maxLife: 180 });
      this.afterimageTimer = 18;
    }
    if (t >= 1) {
      this.isDashing = false;
      caster.isMovementLocked = false;
      caster.isCrowdControlImmune = false;
      Combat.grantShield(caster, caster.maxHp * this.shieldPercentMaxHp, this.shieldDuration);
      this.cooldownRemaining = this.maxCooldown;
      effects.spawnAttackEffect(caster.x, caster.y, caster.x, caster.y, '#ffffff');
      this._dashCaster = null;
    }
  }

  draw(ctx, camera) {
    for (const image of this.afterimages) {
      const alpha = (image.life / image.maxLife) * 0.48;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#fff3e0';
      ctx.beginPath();
      ctx.ellipse(camera.worldToScreenX(image.x), camera.worldToScreenY(image.y), 15, 23, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  refreshCooldown() { this.cooldownRemaining = 0; }

  reset() {
    if (this._dashCaster) {
      this._dashCaster.isMovementLocked = false;
      this._dashCaster.isCrowdControlImmune = false;
    }
    this.isDashing = false;
    this.cooldownRemaining = 0;
    this._dashCaster = null;
  }
}

/**
 * Chou: The Way of Dragon (Skill 3)
 * Phase 1 launches a nearby enemy hero airborne and opens a five-second
 * chase recast. Phase 2 dashes Chou directly to that target, then
 * repeatedly kicks them in the air before the landing stun.
 */
class WayOfDragonSkill {
  constructor() {
    this.slot = 3;
    this.name = 'The Way of Dragon';
    this.locked = false;
    this.maxCooldown = 18000;
    this.cooldownRemaining = 0;
    this.range = 90;
    this.roundhouseDamage = 21;
    this.chaseKickDamage = 9;
    this.airborneDuration = 1000;
    this.landingStunDuration = 550;
    this.launchDistance = 250;
    this.launchDuration = 400;
    this.chaseDuration = 200;
    this.chaseKickDuration = 800;
    this.chaseKickInterval = 160;
    this.recastWindow = 900;
    this.recastTimer = 0;
    this.recastLabel = 'CHASE!';
    this.phase = 'idle'; // 'idle' | 'launching' | 'awaiting_recast' | 'chasing' | 'kicking'
    this.phaseTimer = 0;
    this.fromX = 0;
    this.fromY = 0;
    this.toX = 0;
    this.toY = 0;
    this.target = null;
    this.onHitKill = null;
    this.afterimages = [];
    this.afterimageTimer = 0;
    this.impacts = [];
    this._caster = null;
    this.targetLaunchFrom = null;
    this.targetLaunchTo = null;
    this.launchDirectionX = 0;
    this.launchDirectionY = 1;
    this.kickTimer = 0;
  }

  get isReady() { return this.phase === 'idle' && this.cooldownRemaining <= 0; }
  // Only Chou's phase-2 dash commits his movement/control. The first
  // kick's launched target continues independently during the recast.
  get isCasting() { return this.phase === 'chasing' || this.phase === 'kicking'; }

  tryCast(caster, effects, onHitKill, hostiles) {
    if (caster.isDead) return false;
    if (this.phase === 'awaiting_recast') {
      this._beginChase(caster);
      return true;
    }
    if (!this.isReady) return false;
    const target = this._findNearestEnemyHero(caster, hostiles);
    if (!target) return false;

    // Phase 1: roundhouse, lift, and launch the hero away.
    this.target = target;
    this.onHitKill = onHitKill;
    this._caster = caster;
    const kickX = target.x - caster.x;
    const kickY = target.y - caster.y;
    const kickLength = Math.sqrt(kickX * kickX + kickY * kickY) || 1;
    this.launchDirectionX = kickX / kickLength;
    this.launchDirectionY = kickY / kickLength;
    this.targetLaunchFrom = { x: target.x, y: target.y };
    let launchX = target.x + this.launchDirectionX * this.launchDistance;
    let launchY = target.y + this.launchDirectionY * this.launchDistance;
    if (target.mapBounds) {
      const clamped = Collision.clampToMap(launchX, launchY, (target.collisionWidth || 28) / 2, (target.collisionHeight || 20) / 2, target.mapBounds);
      launchX = clamped.x;
      launchY = clamped.y;
    }
    this.targetLaunchTo = { x: launchX, y: launchY };
    this.phase = 'launching';
    this.phaseTimer = 0;
    this.afterimageTimer = 0;
    const killed = Combat.applyDamage(target, this.roundhouseDamage);
    Combat.applyAirborne(target, this.airborneDuration);
    effects.spawnAttackEffect(caster.x, caster.y, target.x, target.y, '#ff9800');
    this._addImpact(target.x, target.y, '#ff9800', 46);
    if (killed && onHitKill) onHitKill(target);
    return true;
  }

  _findNearestEnemyHero(caster, hostiles) {
    let nearestHero = null;
    let nearestDistance = Infinity;
    for (const candidate of hostiles || []) {
      // Skill target lists contain creeps and one opposing hero. The
      // ultimate intentionally ignores every non-hero target.
      if (!candidate || candidate.hp <= 0 || candidate.isDead || candidate instanceof Creep) continue;
      const distance = Combat.distance(caster.x, caster.y, candidate.x, candidate.y);
      if (distance <= this.range && distance < nearestDistance) {
        nearestHero = candidate;
        nearestDistance = distance;
      }
    }
    return nearestHero;
  }

  update(deltaTime, hostiles, effects, onHitKill, caster) {
    if (this.cooldownRemaining > 0) this.cooldownRemaining -= deltaTime;
    for (const image of this.afterimages) image.life -= deltaTime;
    this.afterimages = this.afterimages.filter(image => image.life > 0);
    for (const impact of this.impacts) impact.life -= deltaTime;
    this.impacts = this.impacts.filter(impact => impact.life > 0);

    if (this.phase === 'idle') return;
    if (!this.target || this.target.hp <= 0) {
      this._finish(caster);
      return;
    }

    if (this.phase === 'awaiting_recast') {
      this.recastTimer -= deltaTime;
      if (this.recastTimer <= 0) this._finish(caster);
      return;
    }

    if (this.phase === 'kicking') {
      this.phaseTimer += deltaTime;
      this.kickTimer += deltaTime;
      while (this.kickTimer >= this.chaseKickInterval && this.target.hp > 0) {
        this.kickTimer -= this.chaseKickInterval;
        this._landAirKick(caster, effects, onHitKill || this.onHitKill);
      }
      this._leaveAfterimage(caster, deltaTime);
      if (this.phaseTimer >= this.chaseKickDuration) {
        this.target.isAirborne = false;
        this.target.airborneDuration = 0;
        this.target.airborneTimeRemaining = 0;
        Combat.applyStun(this.target, this.landingStunDuration);
        effects.spawnAttackEffect(this.target.x, this.target.y, this.target.x, this.target.y, '#ff5722');
        this._addImpact(this.target.x, this.target.y, '#ffcc80', 74);
        this._finish(caster);
      }
      return;
    }

    this.phaseTimer += deltaTime;
    const duration = this.phase === 'launching' ? this.launchDuration : this.chaseDuration;
    const t = Math.min(1, this.phaseTimer / duration);
    if (this.phase === 'launching' && this.targetLaunchFrom && this.targetLaunchTo) {
      // Skip position manipulation if target is immune to crowd control
      if (!this.target.isCrowdControlImmune && !this.target.isInvulnerable) {
        this.target.x = this.targetLaunchFrom.x + (this.targetLaunchTo.x - this.targetLaunchFrom.x) * t;
        this.target.y = this.targetLaunchFrom.y + (this.targetLaunchTo.y - this.targetLaunchFrom.y) * t;
      }
    } else {
      caster.x = this.fromX + (this.toX - this.fromX) * t;
      caster.y = this.fromY + (this.toY - this.fromY) * t;
      this._leaveAfterimage(caster, deltaTime);
    }

    if (t < 1) return;
    if (this.phase === 'launching') {
      this.phase = 'awaiting_recast';
      this.recastTimer = this.recastWindow;
      this.phaseTimer = 0;
    } else {
      this._beginAirKickFlurry(caster);
    }
  }

  _beginChase(caster) {
    if (!this.target || this.target.hp <= 0) {
      this._finish(caster);
      return;
    }
    this.fromX = caster.x;
    this.fromY = caster.y;
    this.toX = this.target.x;
    this.toY = this.target.y;
    this.phase = 'chasing';
    this.phaseTimer = 0;
    this.afterimageTimer = 0;
    caster.isMovementLocked = true;
  }

  _beginAirKickFlurry(caster) {
    this.phase = 'kicking';
    this.phaseTimer = 0;
    this.kickTimer = this.chaseKickInterval; // the first hit lands immediately
    this.afterimageTimer = 0;
    // Renew the knock-up: the player may have waited until the end of
    // the recast window before starting the follow-up.
    Combat.applyAirborne(this.target, this.chaseKickDuration + 120);
    caster.isMovementLocked = true;
  }

  _landAirKick(caster, effects, onHitKill) {
    const killed = Combat.applyDamage(this.target, this.chaseKickDamage);
    Combat.applyAirborne(this.target, this.chaseKickDuration + 120);
    effects.spawnAttackEffect(caster.x, caster.y, this.target.x, this.target.y, '#ff7043');
    this._addImpact(this.target.x, this.target.y, '#ff7043', 34);
    if (killed && onHitKill) onHitKill(this.target);
  }

  _leaveAfterimage(caster, deltaTime) {
    this.afterimageTimer -= deltaTime;
    if (this.afterimageTimer <= 0) {
      this.afterimages.push({ x: caster.x, y: caster.y, life: 200, maxLife: 200 });
      this.afterimageTimer = 24;
    }
  }

  _addImpact(x, y, color, radius) {
    this.impacts.push({ x, y, color, radius, life: 260, maxLife: 260 });
  }

  _finish(caster) {
    this.phase = 'idle';
    this.phaseTimer = 0;
    this.cooldownRemaining = this.maxCooldown;
    caster.isMovementLocked = false;
    this.target = null;
    this.onHitKill = null;
    this._caster = null;
    this.targetLaunchFrom = null;
    this.targetLaunchTo = null;
  }

  draw(ctx, camera) {
    for (const image of this.afterimages) {
      ctx.save();
      ctx.globalAlpha = (image.life / image.maxLife) * 0.5;
      ctx.fillStyle = '#ff7043';
      ctx.beginPath();
      ctx.ellipse(camera.worldToScreenX(image.x), camera.worldToScreenY(image.y), 16, 24, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    for (const impact of this.impacts) {
      const alpha = impact.life / impact.maxLife;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = impact.color;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(camera.worldToScreenX(impact.x), camera.worldToScreenY(impact.y), impact.radius * (1 - alpha) + 12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  reset() {
    if (this._caster) this._caster.isMovementLocked = false;
    this.phase = 'idle';
    this.cooldownRemaining = 0;
    this.target = null;
    this.onHitKill = null;
    this._caster = null;
    this.targetLaunchFrom = null;
    this.targetLaunchTo = null;
  }
}

/** Inert placeholder for a future unused skill slot. */
class LockedSkill {
  constructor(slot) {
    this.slot = slot;
    this.name = 'Locked';
    this.locked = true;
    this.cooldownRemaining = 0;
    this.maxCooldown = 0;
  }

  get isReady() {
    return false;
  }

  tryCast(caster, effects, onHitKill, hostiles) {
    return false;
  }

  update() {
    // Nothing to do - locked skills have no behavior yet.
  }

  draw() {
    // Nothing to draw.
  }
}

/**
 * SkillManager
 * ------------------------------------------------------
 * Owns all 3 skill slots and gives game.js one simple interface:
 * tryCast(slotNumber, ...) to cast, update()/draw() every frame,
 * and `skills` (indexed 0-2) for the UI to read cooldown state from.
 * ------------------------------------------------------
 */
// ------------------------------------------------------
// Skill visual-state sync (PvP)
// ------------------------------------------------------
// The guest's browser never runs any skill simulation of its own - it
// has no SkillManager driving damage/cooldowns, only a purely visual
// copy fed from the host's authoritative state (see pvp-guest.js).
// These helpers turn a live skill object into plain, network-safe
// data (no entity references, DOM nodes, or functions) and restore
// it onto a same-shaped local instance so every projectile, dash
// afterimage, and stance ring the host sees is visible to the guest
// too - not just hero position/HP.
const SKILL_SYNC_EXCLUDE_KEYS = new Set(['siblingSkills', 'shunpoSkill', 'hitTarget', 'markedTarget']);

// Some skills hold nested class instances (a thrown blade, a landed
// shadow clone...) that have their own draw() method. Sanitizing has to
// tag which class they were so applySyncState can rebuild a real
// instance (with working methods) instead of a dead plain object -
// otherwise the very first skill.draw() call on the guest throws and
// permanently freezes its render loop (nothing renders ever again).
const SKILL_SYNC_CLASS_REGISTRY = { Projectile, SwordWaveBlade, ShurikenBlade, ShadowClone };

function sanitizeSkillValueForSync(value) {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' ? undefined : value;
  }
  if (value instanceof Image || (typeof HTMLElement !== 'undefined' && value instanceof HTMLElement)) return undefined;
  // Entities (Player/Enemy/Creep/Tower) are referenced by several skills
  // (e.g. a bolt's hitTarget, a shadow's markedTarget) purely so update()
  // logic can read their live hp/position - never needed for draw(), and
  // sending one would try to serialize sprites/animators/etc. Detect them
  // structurally rather than importing every class here.
  if (typeof value.hp === 'number' && (value.sheetImage || value.animator || value.image)) return undefined;
  if (value instanceof Set) return Array.from(value).map(sanitizeSkillValueForSync);
  if (value instanceof Map) return undefined;
  if (Array.isArray(value)) return value.map(sanitizeSkillValueForSync);

  const out = {};
  const ctorName = value.constructor && value.constructor.name;
  if (ctorName && SKILL_SYNC_CLASS_REGISTRY[ctorName]) out.__cls = ctorName;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (key.startsWith('_') || SKILL_SYNC_EXCLUDE_KEYS.has(key)) continue;
    const sanitized = sanitizeSkillValueForSync(value[key]);
    if (sanitized !== undefined) out[key] = sanitized;
  }
  return out;
}

/**
 * Turns one sanitized plain object back into something safe to draw():
 * a real instance (correct prototype, so .draw()/etc. exist) if it was
 * tagged with __cls, otherwise a plain data bag (fine for leaf data
 * like {x,y,life,maxLife} afterimage/trail points that no code calls
 * methods on).
 */
function buildSkillSyncInstance(data) {
  if (data.__cls && SKILL_SYNC_CLASS_REGISTRY[data.__cls]) {
    const instance = Object.create(SKILL_SYNC_CLASS_REGISTRY[data.__cls].prototype);
    applySkillValueForSync(instance, data);
    return instance;
  }
  const plain = {};
  applySkillValueForSync(plain, data);
  return plain;
}

/** Recursively re-applies plain sync data onto a live skill instance's fields. */
function applySkillValueForSync(target, data) {
  if (!data || typeof data !== 'object' || !target || typeof target !== 'object') return;
  for (const key in data) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
    if (key === '__cls') continue;
    const value = data[key];
    if (Array.isArray(value)) {
      target[key] = value.map(item => (item && typeof item === 'object') ? buildSkillSyncInstance(item) : item);
    } else if (value && typeof value === 'object') {
      target[key] = buildSkillSyncInstance(value);
    } else {
      target[key] = value;
    }
  }
}

class SkillManager {
  /**
   * @param {string} [character] - which hero's kit to build. All 3
   *        slots differ for Hayabusa (Phantom Shuriken, Quad Shadow,
   *        Shadow Kill); Benedetta gets Phantom Slash, An Eye for an
   *        Eye, and Alecto: Final Blow; Chou gets Jeet Kune Do,
   *        Shunpo, and The Way of Dragon. Everyone else gets Gusion's kit.
   */
  constructor(character = 'gusion') {
    const isHayabusa = character === 'hayabusa';
    const isBenedetta = character === 'benedetta';
    const isChou = character === 'chou';
    const skillOne = isHayabusa ? new PhantomShurikenSkill()
      : isBenedetta ? new PhantomSlashSkill()
      : isChou ? new JeetKuneDoSkill()
      : new BladeThrowSkill();
    const skillTwo = isHayabusa ? new QuadShadowSkill()
      : isBenedetta ? new EyeForAnEyeSkill()
      : isChou ? new ShunpoSkill()
      : new SwordWavesSkill();
    const skillThree = isHayabusa ? new ShadowKillSkill()
      : isBenedetta ? new AlectoFinalBlowSkill()
      : isChou ? new WayOfDragonSkill()
      : new UltimateSkill();

    this.skills = [
      skillOne,    // slot 1
      skillTwo,    // slot 2
      skillThree   // slot 3
    ];

    // The ultimate needs direct references to Skills 1 & 2 so it can
    // instantly refresh their cooldowns on cast (its whole purpose).
    // Shadow Kill doesn't use this (see its reset() note), but setting
    // it unconditionally keeps every Skill 3 the same shape.
    this.skills[2].siblingSkills = [this.skills[0], this.skills[1]];
    if (isChou) this.skills[0].shunpoSkill = this.skills[1];
    this._deathInterrupted = false;
  }

  /**
   * @param {number} slotNumber - 1, 2, or 3
   * @param {Array} hostiles - valid targets, needed by skills that
   *        resolve instantly on cast (like Sword Waves)
   */
  tryCast(slotNumber, caster, effects, onHitKill, hostiles) {
    // Crowd control prevents every hero from beginning a new skill,
    // including AI casts and recasts routed through this shared entry point.
    if (caster.isStunned) return false;
    if (caster.isChargingPassive || caster.isPassiveDashing) return false;
    if (this.isCasting && !this.canCastDuringAnimation(slotNumber, caster)) return false;
    const skill = this.skills[slotNumber - 1];
    if (!skill) return false;
    return skill.tryCast(caster, effects, onHitKill, hostiles);
  }

  /**
   * Gusion can call Sword Waves back while he is in a skill dash. This
   * is deliberately limited to Skill 2's armed return phase, so an
   * animation never opens up unrelated casts or a fresh blade throw.
   */
  canCastDuringAnimation(slotNumber, caster) {
    const skill = this.skills[slotNumber - 1];
    return caster.character === 'gusion'
      && slotNumber === 2
      && skill instanceof SwordWavesSkill
      && skill.phase === 'awaiting_recast';
  }

  // A skill exposes this only while it has a committed animation.
  // Recast windows and independent projectiles do not block new casts.
  get isCasting() {
    return this.skills.some(skill => skill.isCasting === true);
  }

  /**
   * @param {Player} caster - passed through so skills that move the
   *        player (like a dash) can do so.
   */
  update(deltaTime, hostiles, effects, onHitKill, caster) {
    // Death immediately interrupts every phase of a cast. Cooldowns still
    // advance during death, so respawning never leaves a frozen timer.
    // Exceptions (see _survivesCasterDeath): the four thrown-projectile
    // skills always, and Benedetta's ultimate once its ground slash
    // trail is planted - those continue independently after the caster dies.
    if (caster && (caster.isDead || caster.hp <= 0)) {
      if (!this._deathInterrupted) {
        for (const skill of this.skills) {
          const continuesAfterDeath = this._survivesCasterDeath(skill);
          const wasInUse = skill.isCasting === true
            || (typeof skill.phase === 'string' && skill.phase !== 'idle');
          if (continuesAfterDeath) {
            // These projectiles may finish returning, but their skill is
            // unavailable from death only if they had already been used.
            if (wasInUse && skill.cooldownRemaining <= 0) {
              skill.cooldownRemaining = skill.maxCooldown || 0;
            }
            continue;
          }

          const remainingCooldown = skill.cooldownRemaining || 0;
          if (typeof skill.reset === 'function') skill.reset();
          // Shadows normally survive Hayabusa's own cooldown reset, but
          // death must also remove their teleport/recast opportunity.
          if (skill instanceof QuadShadowSkill) {
            skill.shadows = [];
            skill.phase = 'idle';
          }
          // A canceled cast enters its normal cooldown; unused ready
          // skills remain ready, and existing cooldowns retain their time.
          skill.cooldownRemaining = remainingCooldown > 0
            ? remainingCooldown
            : (wasInUse ? (skill.maxCooldown || 0) : 0);
        }
        this._deathInterrupted = true;
      }
      for (const skill of this.skills) {
        const continuesAfterDeath = this._survivesCasterDeath(skill);
        if (continuesAfterDeath) {
          skill.update(deltaTime, hostiles, effects, onHitKill, caster);
        } else if (skill.cooldownRemaining > 0) {
          skill.cooldownRemaining = Math.max(0, skill.cooldownRemaining - deltaTime);
        }
      }
      return;
    }

    this._deathInterrupted = false;

    for (const skill of this.skills) {
      skill.update(deltaTime, hostiles, effects, onHitKill, caster);
    }
  }

  // Thrown projectiles remain in the world once cast, and Benedetta's
  // ultimate's ground trail is likewise independent of her once planted -
  // these therefore continue their active flight/return/trail behavior
  // through crowd control and death, unlike committed melee/dash abilities.
  updatePersistentThrows(deltaTime, hostiles, effects, onHitKill, caster) {
    for (const skill of this.skills) {
      if (this._survivesCasterDeath(skill)) {
        skill.update(deltaTime, hostiles, effects, onHitKill, caster);
      }
    }
  }

  _isPersistentThrowSkill(skill) {
    return skill instanceof BladeThrowSkill
      || skill instanceof SwordWavesSkill
      || skill instanceof PhantomShurikenSkill
      || skill instanceof QuadShadowSkill;
  }

  /**
   * True for any skill whose currently-active effect should keep
   * playing out even after the caster dies (or, for the persistent-throw
   * skills, gets stunned) - the four thrown-projectile skills always,
   * since their projectile is already independent of the caster, plus
   * Benedetta's ultimate specifically while its ground slash trail is
   * active. The dash portion of her ultimate still gets interrupted
   * like any other committed cast if she dies mid-dash - only the
   * already-planted trail (and its damage/slow tick and draw()) survives,
   * matching how a real static hazard shouldn't vanish just because its
   * caster went down.
   */
  _survivesCasterDeath(skill) {
    if (this._isPersistentThrowSkill(skill)) return true;
    if (skill instanceof AlectoFinalBlowSkill && skill.phase === 'trail') return true;
    return false;
  }

  draw(ctx, camera) {
    for (const skill of this.skills) {
      skill.draw(ctx, camera);
    }
  }

  /**
   * PvP host only: a plain-data snapshot of every skill's visual state
   * (projectile positions, dash progress, afterimages, stance rings...)
   * cheap enough to broadcast every state tick alongside position/HP.
   */
  getSyncState() {
    return this.skills.map(skill => sanitizeSkillValueForSync(skill));
  }

  /**
   * PvP guest only: applies a snapshot from getSyncState() onto this
   * (otherwise-inert) local SkillManager so its draw() output matches
   * the host's, without ever running tryCast/update/damage locally.
   */
  applySyncState(state) {
    if (!Array.isArray(state)) return;
    for (let i = 0; i < this.skills.length && i < state.length; i++) {
      applySkillValueForSync(this.skills[i], state[i]);
    }
  }
}
