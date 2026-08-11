/**
 * tower.js
 * ------------------------------------------------------
 * A stationary defensive structure belonging to a faction
 * ('player' or 'enemy').
 *  - Has HP and can be destroyed.
 *  - While alive, keeps aggro on the first hostile that enters its
 *    range. Creeps shield a later-arriving hero unless that hero
 *    attacks the tower's defending hero.
 *  - Does not move.
 * ------------------------------------------------------
 */

class Tower {
  /**
   * @param {number} x - world x position (center)
   * @param {number} y - world y position (center)
   * @param {string} faction - 'player' or 'enemy'. Controls sprite,
   *        health-bar/range-ring color; game.js decides which units
   *        actually count as hostile to this tower.
   */
  constructor(x, y, faction = 'enemy') {
    this.x = x;
    this.y = y;
    this.faction = faction;

    // Stats
    this.maxHp = 500;
    this.hp = this.maxHp;
    this.baseAttackDamage = 12;
    this.attackDamage = 12;
    this.attackRange = 220;
    this.attackCooldown = 1200; // ms
    this.cooldownRemaining = 0;
    this.consecutiveHits = 0; // for progressive damage increase
    this.damageBonus = 0;

    // Aggro state. Entry order is deliberately kept independently of
    // distance so walking closer to a tower never steals its target.
    this.currentTarget = null;
    this.forcedHeroTarget = null;
    this._rangeEntries = new Map();
    this._entrySequence = 0;
    this._heroEnteredFirst = false;
    this.protectedHero = null;

    // Visuals
    this.drawWidth = 72;
    this.drawHeight = 105;
    this.image = new Image();
    this.image.src = faction === 'player'
      ? 'assets/map/tower_player.png'
      : 'assets/map/tower.png';
    this.barColor = faction === 'player' ? '#42a5f5' : '#ef5350';
    this.rangeColor = faction === 'player' ? 'rgba(66, 165, 245, 0.35)' : 'rgba(239, 83, 80, 0.35)';

    this.isDestroyed = false;
  }

  /**
   * Updates attack-cooldown timing and fires at the correct aggro
   * target. `protectedHero` is the friendly hero this tower protects.
   * @param {number} deltaTime - ms since last frame
   * @param {Array<{x:number,y:number,hp:number}>} hostiles - units this
   *        tower is allowed to attack (built by game.js based on faction)
   * @param {EffectSystem} effects
   */
  update(deltaTime, hostiles, effects, protectedHero = null) {
    if (this.isDestroyed) return;

    this.protectedHero = protectedHero;
    const targetsInRange = this._trackRangeEntries(hostiles, protectedHero);

    if (this.cooldownRemaining > 0) {
      this.cooldownRemaining -= deltaTime;
    }

    if (this.cooldownRemaining <= 0) {
      const target = this._selectTarget(targetsInRange, protectedHero);
      if (target) {
        Combat.applyDamage(target, this.attackDamage, this);
        const color = this.faction === 'player' ? '#64b5f6' : '#ef5350';
        effects.spawnAttackEffect(this.x, this.y - 20, target.x, target.y, color);
        this.cooldownRemaining = this.attackCooldown;

        // Progressive damage: increase damage after each hit
        this.consecutiveHits++;
        this.damageBonus = Math.min(this.consecutiveHits * 2, 20); // Max +20 damage bonus
        this.attackDamage = this.baseAttackDamage + this.damageBonus;
      } else {
        // Reset consecutive hits if no target in range
        this.consecutiveHits = 0;
        this.damageBonus = 0;
        this.attackDamage = this.baseAttackDamage;
      }
    }

    if (this.hp <= 0) {
      this.isDestroyed = true;
    }
  }

  /**
   * Records which hostile entered range first. Entries are cleared as
   * soon as a unit leaves, dies, or becomes untargetable.
   */
  _trackRangeEntries(hostiles, protectedHero) {
    const inRange = [];
    for (const h of hostiles) {
      if (!h || h.hp <= 0) continue;
      const d = Combat.distance(this.x, this.y, h.x, h.y);
      if (d <= this.attackRange) inRange.push(h);
    }

    const inRangeSet = new Set(inRange);
    for (const unit of this._rangeEntries.keys()) {
      if (!inRangeSet.has(unit)) this._rangeEntries.delete(unit);
    }

    for (const unit of inRange) {
      if (this._rangeEntries.has(unit)) continue;
      // A hero is considered the first entrant only when the tower
      // range was otherwise empty at the moment they crossed in.
      if (unit === protectedHero) this._heroEnteredFirst = this._rangeEntries.size === 0;
      this._rangeEntries.set(unit, ++this._entrySequence);
    }

    if (!inRangeSet.has(protectedHero)) {
      this._heroEnteredFirst = false;
      if (this.forcedHeroTarget === protectedHero) this.forcedHeroTarget = null;
    }

    return inRange;
  }

  /**
   * Alerts the tower that an enemy hero attacked its protected hero.
   * This overrules creep protection until the attacking hero leaves
   * range, dies, or becomes untargetable.
   */
  notifyHeroAttack(attacker, protectedHero) {
    if (this.isDestroyed || protectedHero !== this.protectedHero) return;
    if (!attacker || attacker.hp <= 0 || attacker.isUntargetable) return;
    if (Combat.inRange(this.x, this.y, attacker.x, attacker.y, this.attackRange)) {
      this.forcedHeroTarget = attacker;
    }
  }

  /**
   * Preserves the existing aggro target while it remains valid. When
   * acquiring a target, creeps take priority over a hero that entered
   * after them; a hero that entered an empty tower range keeps normal
   * first-entry priority. Hero attacks on the defender always override.
   */
  _selectTarget(targetsInRange, protectedHero) {
    const isValid = (unit) => targetsInRange.includes(unit);
    const creepsPresent = targetsInRange.some(unit => unit !== protectedHero);

    if (this.forcedHeroTarget && isValid(this.forcedHeroTarget)) {
      this.currentTarget = this.forcedHeroTarget;
      return this.currentTarget;
    }
    this.forcedHeroTarget = null;

    if (isValid(this.currentTarget)
      && !(this.currentTarget === protectedHero && creepsPresent && !this._heroEnteredFirst)) {
      return this.currentTarget;
    }

    if (isValid(protectedHero) && (!creepsPresent || this._heroEnteredFirst)) {
      this.currentTarget = protectedHero;
      return this.currentTarget;
    }

    let oldestCreep = null;
    let oldestEntry = Infinity;
    for (const unit of targetsInRange) {
      if (unit === protectedHero) continue;
      const entry = this._rangeEntries.get(unit) || Infinity;
      if (entry < oldestEntry) {
        oldestCreep = unit;
        oldestEntry = entry;
      }
    }
    this.currentTarget = oldestCreep;
    return this.currentTarget;
  }

  /**
   * Draws the tower, its range circle (only when something is
   * near, to keep the view uncluttered), and its health bar.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} screenX
   * @param {number} screenY
   * @param {boolean} showRange - whether to draw the faint range indicator
   */
  draw(ctx, screenX, screenY, showRange) {
    if (this.isDestroyed || this.hp <= 0) return;

    if (showRange) {
      ctx.save();
      ctx.strokeStyle = this.rangeColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(screenX, screenY, this.attackRange, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    if (this.image.complete) {
      ctx.drawImage(
        this.image,
        screenX - this.drawWidth / 2,
        screenY - this.drawHeight,
        this.drawWidth,
        this.drawHeight
      );
    }

    Combat.drawHealthBar(
      ctx,
      screenX,
      screenY - this.drawHeight - 10,
      60,
      this.hp,
      this.maxHp,
      this.barColor
    );
  }
}
