/**
 * ui.js
 * ------------------------------------------------------
 * Handles all HUD/UI updates: player coordinates and FPS
 * counter. Keeps DOM manipulation out of game.js so the
 * main loop stays focused on game logic.
 * ------------------------------------------------------
 */

class UIManager {
  constructor() {
    this.fpsElement = document.getElementById('fps-value');
    this.gameTimeElement = document.getElementById('game-time');
    this.xElement = document.getElementById('player-x');
    this.yElement = document.getElementById('player-y');
    this.hpElement = document.getElementById('player-hp');
    this.maxHpElement = document.getElementById('player-max-hp');
    this.kdaElement = document.getElementById('player-kda');
    this.recallStatusElement = document.getElementById('recall-status');
    this.bannerElement = document.getElementById('banner');
    this.bannerTimeout = null;
    this.attackButton = document.getElementById('attack-button');
    this.energyBar = document.getElementById('energy-bar');
    this.energyBarFill = document.getElementById('energy-bar-fill');
    // Upper-middle kills-only scoreboard - same "you" vs "enemy" framing
    // as the KDA readout above, just hero kills with no death/assist count.
    this.scoreboardPlayerKillsElement = document.getElementById('scoreboard-player-kills');
    this.scoreboardEnemyKillsElement = document.getElementById('scoreboard-enemy-kills');

    // Skill bar - one entry per slot, so _updateSkillSlot can loop
    // over them instead of repeating the same three lines per slot.
    this.skillSlotRefs = [
      {
        slot: document.getElementById('skill-slot-1'),
        name: document.querySelector('#skill-slot-1 .skill-name'),
        overlay: document.getElementById('skill-overlay-1'),
        text: document.getElementById('skill-text-1')
      },
      {
        slot: document.getElementById('skill-slot-2'),
        name: document.querySelector('#skill-slot-2 .skill-name'),
        overlay: document.getElementById('skill-overlay-2'),
        text: document.getElementById('skill-text-2')
      },
      {
        slot: document.getElementById('skill-slot-3'),
        name: document.querySelector('#skill-slot-3 .skill-name'),
        overlay: document.getElementById('skill-overlay-3'),
        text: document.getElementById('skill-text-3')
      }
    ];

    // FPS is only recalculated a few times per second so the
    // number doesn't flicker/jitter every single frame.
    this.fpsUpdateInterval = 500; // ms
    this.fpsTimer = 0;
    this.frameCounter = 0;
    this.lastFps = 0;
  }

  /**
   * Call once per frame.
   * @param {number} deltaTime - ms since last frame
   * @param {Player} player - the player instance to read coordinates from
   * @param {SkillManager} [skillManager] - optional, shows cooldown status if provided
   * @param {number} [gameTime] - optional, total game time in ms for timer display
   */
  update(deltaTime, player, skillManager, gameTime) {
    // ---- FPS tracking ----
    this.frameCounter++;
    this.fpsTimer += deltaTime;

    if (this.fpsTimer >= this.fpsUpdateInterval) {
      this.lastFps = Math.round((this.frameCounter * 1000) / this.fpsTimer);
      this.fpsElement.textContent = this.lastFps;
      this.frameCounter = 0;
      this.fpsTimer = 0;
    }

    // ---- Game timer display ----
    if (gameTime !== undefined) {
      const totalSeconds = Math.floor(gameTime / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      this.gameTimeElement.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }

    // ---- Coordinate display ----
    this.xElement.textContent = Math.round(player.x);
    this.yElement.textContent = Math.round(player.y);

    // ---- Combat display ----
    this.hpElement.textContent = Math.round(player.hp);
    this.maxHpElement.textContent = player.maxHp;
    // KDA: Player Kills / Deaths / Creep Kills
    this.kdaElement.textContent = `${player.playerKills}/${player.deaths}/${player.kills}`;
    // Scoreboard - hero kills only, no death/assist count.
    if (this.scoreboardPlayerKillsElement) this.scoreboardPlayerKillsElement.textContent = player.playerKills;
    if (this.scoreboardEnemyKillsElement) this.scoreboardEnemyKillsElement.textContent = player.deaths;
    // Recall status
    if (player.isRecalling) {
      this.recallStatusElement.textContent = `${Math.ceil(player.recallTimer / 1000)}s`;
      this.recallStatusElement.style.color = '#81d4fa';
    } else {
      this.recallStatusElement.textContent = 'Ready';
    this.recallStatusElement.style.color = '#7ee0ff';
    }

    const isBenedetta = player.character === 'benedetta';
    // Every hero needs a tappable basic attack in Android mode. On desktop,
    // retain the previous Benedetta-only button because other heroes use
    // mouse click / Space for their regular attacks.
    const isMobileMode = document.body.classList.contains('mobile-mode');
    this.attackButton.style.display = (isBenedetta || isMobileMode) ? 'block' : 'none';
    this.energyBar.style.display = isBenedetta ? 'block' : 'none';
    if (isBenedetta) {
      this.energyBarFill.style.width = `${(player.energy / player.maxEnergy) * 100}%`;
      this.attackButton.textContent = player.energy >= player.maxEnergy ? 'DASH!' : 'CHARGE';
      this.attackButton.classList.toggle('charging', player.isChargingPassive);
    } else {
      this.attackButton.textContent = 'ATTACK';
      this.attackButton.classList.remove('charging');
    }

    // ---- Skill bar ----
    if (skillManager) {
      for (let i = 0; i < this.skillSlotRefs.length; i++) {
        this._updateSkillSlot(skillManager.skills[i], this.skillSlotRefs[i]);
      }
    }
  }

  /**
   * Updates the on-screen skill icon for a single skill: the dark
   * cooldown overlay drains away as it recharges, the countdown
   * text shows seconds remaining, and a gold pulse appears while
   * a free recast (like Skill 1's dash window) is available.
   * @param {BladeThrowSkill|SwordWavesSkill} skill
   * @param {{slot:Element, overlay:Element, text:Element}} refs
   */
  _updateSkillSlot(skill, refs) {
    // No data yet for this slot - show it blank rather than crashing
    // on skill.name below (defensive; shouldn't normally happen since
    // every real SkillManager always has exactly 3 populated skills,
    // but costs nothing to guard against a stray undefined/null).
    if (!skill) {
      if (refs.name) refs.name.textContent = '';
      refs.slot.classList.remove('recast-ready');
      refs.overlay.style.height = '0%';
      refs.text.textContent = '';
      return;
    }

    // The three slots are reused by every hero, so their labels must
    // follow the actual skill instance rather than Gusion's HTML defaults.
    if (refs.name) refs.name.textContent = skill.name || 'Locked';

    // Only BladeThrowSkill has a `phase`; other skills simply won't
    // match 'awaiting_recast', so this stays safe for every skill type.
    const isRecastReady = skill.phase === 'awaiting_recast';
    refs.slot.classList.toggle('recast-ready', isRecastReady);

    if (isRecastReady) {
      refs.overlay.style.height = '0%';
      refs.text.textContent = skill.recastLabel || 'RECAST!';
    } else if (skill.cooldownRemaining > 0) {
      const pct = (skill.cooldownRemaining / skill.maxCooldown) * 100;
      refs.overlay.style.height = `${pct}%`;
      refs.text.textContent = (skill.cooldownRemaining / 1000).toFixed(1);
    } else {
      refs.overlay.style.height = '0%';
      refs.text.textContent = '';
    }
  }

  /**
   * Briefly shows a message in the center-top banner (e.g. "Tower
   * Destroyed!"). Re-triggering while one is already visible just
   * restarts the timer with the new text.
   * @param {string} text
   * @param {number} duration - ms before the banner fades out
   */
  showBanner(text, duration = 2500) {
    this.bannerElement.textContent = text;
    this.bannerElement.classList.add('visible');

    if (this.bannerTimeout) clearTimeout(this.bannerTimeout);
    this.bannerTimeout = setTimeout(() => {
      this.bannerElement.classList.remove('visible');
    }, duration);
  }
}
