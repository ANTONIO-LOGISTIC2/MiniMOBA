/**
 * game.js
 * ------------------------------------------------------
 * The main entry point and game loop.
 *
 * Responsibilities:
 *  - Set up the canvas and handle resizing.
 *  - Define the map (size + boundaries).
 *  - Create the Player, Camera, and UIManager instances.
 *  - Run the requestAnimationFrame loop: update -> draw.
 * ------------------------------------------------------
 */

class Game {
  /**
   * @param {string} [characterSprite] - path to the sprite sheet for
   *        the hero the player picked on the main menu. Defaults to
   *        Gusion if the game is somehow started without a selection.
   * @param {Object} [pvpConfig] - present only for PvP host matches:
   *        { networkClient, guestCharacter } - the enemy hero becomes
   *        a real remote player (guestCharacter's kit) fed by network
   *        input instead of the AI. Absent entirely for AI-mode games.
   */
  constructor(characterSprite = 'assets/player/gusion.png', pvpConfig = null) {
    // Remembered so a post-death/victory restart respawns the player
    // as the same hero they picked at the main menu.
    this.characterSprite = characterSprite;
    this.pvpConfig = pvpConfig;
    this.networkClient = pvpConfig ? pvpConfig.networkClient : null;

    // Enemy sprite is one of the other characters (not the player's choice).
    // In a PvP host match, it's whichever character the guest picked instead.
    const characters = ['gusion', 'hayabusa', 'benedetta', 'chou'];
    const playerChar = characters.find(c => characterSprite.includes(c)) || 'gusion';
    this.playerChar = playerChar; // remembered so a restart rebuilds the same hero's kit
    let enemyChar;
    if (pvpConfig && pvpConfig.guestCharacter) {
      enemyChar = pvpConfig.guestCharacter;
    } else {
      const otherChars = characters.filter(c => c !== playerChar);
      enemyChar = otherChars[Math.floor(Math.random() * otherChars.length)];
    }
    this.enemySprite = `assets/player/${enemyChar}.png`;
    this.enemyChar = enemyChar; // Store for enemy skill initialization

    // Game loop state
    this.isRunning = true;

    // ---- Canvas setup ----
    this.canvas = document.getElementById('gameCanvas');
    this.ctx = this.canvas.getContext('2d');

    // Mobile-only minimap - grabbed here even though it's only ever
    // drawn/visible in mobile mode, so the reference is ready either way.
    this.minimapCanvas = document.getElementById('minimap-canvas');
    this.minimapCtx = this.minimapCanvas ? this.minimapCanvas.getContext('2d') : null;
    this._resizeCanvas();
    window.addEventListener('resize', () => this._resizeCanvas());

    // ---- Map setup ----
    // A large world, much bigger than the visible viewport,
    // so the camera has room to follow the player around.
    this.mapWidth = 3000;
    this.mapHeight = 3000;
    this.mapBounds = { minX: 0, minY: 0, maxX: this.mapWidth, maxY: this.mapHeight };

    // Grass tile texture used to fill the background map.
    this.grassTile = new Image();
    this.grassTile.src = 'assets/map/grass_tile.png';
    this.grassPattern = null; // created once the image finishes loading
    this.grassTile.onload = () => {
      this.grassPattern = this.ctx.createPattern(this.grassTile, 'repeat');
    };

    // ---- Lane + combat entities ----
    // A simple lane running east-to-west through the middle of the
    // map, with a base/tower on each end. Both sides spawn creep
    // waves that walk toward the opposing base, fighting anything
    // hostile they run into along the way.
    const laneY = this.mapHeight / 2;
    const playerBaseX = 300;
    const enemyBaseX = this.mapWidth - 300;

    // ---- Core systems ----
    this.player = new Player(playerBaseX, laneY, this.mapBounds, characterSprite);
    this.camera = new Camera(this.canvas.width, this.canvas.height, this.mapBounds);
    this.ui = new UIManager();
    this.effects = new EffectSystem();
    this.skillManager = new SkillManager(playerChar);
    Combat.onDamageApplied = (target, source) => this._notifyTowerOfHeroAttack(target, source);

    // Surrender button - same handler for AI mode and PVP host; the
    // guest side wires its own copy of this button in pvp-guest.js.
    const surrenderButton = document.getElementById('surrender-button');
    if (surrenderButton) surrenderButton.onclick = () => this._handleSurrenderClick();

    // Store initial positions for restart (player spawns at base)
    this.playerSpawnX = playerBaseX;
    this.playerSpawnY = laneY;

    // Visual reference line + the path player-faction creeps walk (west -> east).
    this.lanePath = [
      { x: playerBaseX, y: laneY },
      { x: enemyBaseX, y: laneY }
    ];
    // Enemy-faction creeps walk from behind their tower (east -> west)
    // Spawn behind enemy tower, walk toward player base
    const enemyLanePath = [
      { x: enemyBaseX, y: laneY }, // spawn behind enemy tower
      { x: playerBaseX, y: laneY }  // walk toward player base
    ];

    this.playerTower = new Tower(playerBaseX + 200, laneY, 'player');
    this.enemyTower = new Tower(enemyBaseX - 200, laneY, 'enemy');

    // Regeneration zones behind each tower (healing areas like MLBB)
    this.playerRegenZone = {
      x: playerBaseX,
      y: laneY,
      radius: 120,
      healRate: 100, // HP per second (increased for faster healing)
      color: 'rgba(76, 175, 80, 0.2)'
    };
    this.enemyRegenZone = {
      x: enemyBaseX,
      y: laneY,
      radius: 120,
      healRate: 100,
      color: 'rgba(244, 67, 54, 0.2)'
    };

    this.playerCreepSpawner = new CreepSpawner(this.lanePath, 'player', 10000, 4);
    this.enemyCreepSpawner = new CreepSpawner(enemyLanePath, 'enemy', 10000, 4);

    // Enemy AI hero - spawns behind enemy tower (mirroring player spawn).
    // In a PvP host match this same object is instead driven by the
    // guest's network input (see _setupPvpHost below).
    this.enemy = new Enemy(enemyBaseX, laneY, this.mapBounds, this.enemySprite, this.enemyChar);

    if (this.networkClient) {
      this._setupPvpHost();
    }

    // Tracks previous alive-state so we can fire a one-time banner
    // the instant a tower actually gets destroyed.
    this._playerTowerWasAlive = true;
    this._enemyTowerWasAlive = true;
    // Guards _endGame() so a tower-destruction and a surrender click
    // (or a stray double-call of either) can't both queue up the
    // 3-second results-screen delay/network messages twice.
    this._matchDeciding = false;
    // Rematch handshake - both sides must click their own Rematch
    // button (in either order) before _startRematch() fires.
    this._localWantsRematch = false;
    this._opponentWantsRematch = false;

    // Timing
    this.lastTimestamp = 0;
    this.gameTime = 0; // Total game time in milliseconds

    // Kick off the main loop.
    requestAnimationFrame((t) => this._loop(t));
  }

  /**
   * Resizes the canvas to fill the browser window and keeps
   * the camera's viewport size in sync.
   */
  _resizeCanvas() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;

    if (this.camera) {
      this.camera.resize(this.canvas.width, this.canvas.height);
    }
  }

  /**
   * The main requestAnimationFrame loop. Computes deltaTime so
   * movement/animation speed stays consistent regardless of
   * the machine's actual frame rate.
   * @param {number} timestamp - provided automatically by rAF
   */
  _loop(timestamp) {
    // Stop the loop if the game is no longer running
    if (!this.isRunning) return;
    
    const deltaTime = timestamp - this.lastTimestamp || 0;
    this.lastTimestamp = timestamp;

    // Guard against huge deltaTime spikes (e.g. tab was inactive),
    // which would otherwise cause the player to "teleport".
    const safeDeltaTime = Math.min(deltaTime, 100);

    // A single bad frame must never permanently freeze the match for
    // either side - without reaching requestAnimationFrame below, the
    // loop stops scheduling itself forever. Log and keep going, same
    // safety net PvpGuestView uses.
    try {
      this._update(safeDeltaTime);
      this._draw();
    } catch (err) {
      console.error('Game frame error (recovered):', err);
    }

    requestAnimationFrame((t) => this._loop(t));
  }

  /**
   * Updates all game logic for this frame.
   * @param {number} deltaTime - ms since last frame (clamped)
   */
  _update(deltaTime) {
    // Update game timer
    this.gameTime += deltaTime;

    this.player.update(deltaTime, this.gameTime);
    const mapDrag = inputHandler.consumeMapDrag();
    if (this.player.isDead) {
      // Dragging the map right should pull the visible world right,
      // which means the camera itself moves in the opposite direction.
      this.camera.panBy(-mapDrag.x, -mapDrag.y);
    } else {
      // Discard any movement collected during normal click-to-attack
      // input and resume the usual player-follow camera on respawn.
      this.camera.follow({ x: this.player.x, y: this.player.y });
    }

    // ---- Regeneration zone healing ----
    // Player heals when standing in their base regen zone
    if (!this.player.isDead && !this.playerTower.isDestroyed) {
      const distToPlayerRegen = Combat.distance(
        this.player.x, this.player.y,
        this.playerRegenZone.x, this.playerRegenZone.y
      );
      if (distToPlayerRegen <= this.playerRegenZone.radius) {
        const healAmount = this.playerRegenZone.healRate * (deltaTime / 1000);
        this.player.hp = Math.min(this.player.maxHp, this.player.hp + healAmount);
      }
    }

    // Enemy AI heals when standing in their base regen zone
    if (!this.enemy.isDead && !this.enemyTower.isDestroyed) {
      const distToEnemyRegen = Combat.distance(
        this.enemy.x, this.enemy.y,
        this.enemyRegenZone.x, this.enemyRegenZone.y
      );
      if (distToEnemyRegen <= this.enemyRegenZone.radius) {
        const healAmount = this.enemyRegenZone.healRate * (deltaTime / 1000);
        this.enemy.hp = Math.min(this.enemy.maxHp, this.enemy.hp + healAmount);
      }
    }

    // ---- Build each faction's hostile-target list ----
    // Enemy creeps/tower/AI can fight: the human player, the player's
    // creeps, and (for creeps only) the player's tower.
    // Player creeps/tower can fight: the enemy creeps, enemy tower, and enemy AI.
    // An untargetable hero (e.g. mid-Shadow Kill) is left out of every
    // list below so nothing can select or attack them while it's active.
    const enemyCreepHostiles = [this.player, ...this.playerCreepSpawner.creeps, this.playerTower].filter(h => !h.isUntargetable);
    const enemyTowerHostiles = [this.player, ...this.playerCreepSpawner.creeps].filter(h => !h.isUntargetable);
    const playerCreepHostiles = [...this.enemyCreepSpawner.creeps, this.enemyTower, this.enemy].filter(h => !h.isUntargetable);
    const playerTowerHostiles = [...this.enemyCreepSpawner.creeps, this.enemy].filter(h => !h.isUntargetable);

    this.enemyCreepSpawner.update(deltaTime, enemyCreepHostiles, this.effects, this.gameTime);
    this.playerCreepSpawner.update(deltaTime, playerCreepHostiles, this.effects, this.gameTime);
    this.enemyTower.update(deltaTime, enemyTowerHostiles, this.effects, this.enemy);
    this.playerTower.update(deltaTime, playerTowerHostiles, this.effects, this.player);
    this.enemy.update(deltaTime, this.player, this.playerCreepSpawner.creeps, this.effects, this.gameTime);
    this.effects.update(deltaTime);

    // Skills can only target creeps and enemy hero (not towers)
    const skillTargets = this._getSkillTargets();
    const previousCombatSource = Combat.activeSource;
    Combat.activeSource = this.player;
    // Crowd control pauses normal casts, but thrown projectiles already
    // in flight continue independently.
    if (!this.player.isStunned || this.player.isDead || this.player.hp <= 0) {
      this.skillManager.update(deltaTime, skillTargets, this.effects, (target) => this._onPlayerKill(target), this.player);
    } else {
      this.skillManager.updatePersistentThrows(deltaTime, skillTargets, this.effects, (target) => this._onPlayerKill(target), this.player);
    }
    Combat.activeSource = previousCombatSource;

    this._checkTowerDestruction();
    // Resolve the charge-button release first. If it begins Benedetta's
    // passive dash this frame, skill input below sees that lock immediately.
    this._handleAttackInput(deltaTime);
    this._handleSkillInput();
    this._handleRecallInput();

    this.ui.update(deltaTime, this.player, this.skillManager, this.gameTime);

    if (this.networkClient) {
      this._broadcastPvpState();
    }
  }

  /**
   * PvP host setup: makes the "enemy" entity a real remote player fed
   * by the guest's input instead of AI, and wires up the network
   * listener that keeps its remoteInput current.
   */
  _setupPvpHost() {
    this.enemy.isRemoteControlled = true;

    // Stored on the instance (rather than as anonymous closures) so a
    // rematch can precisely unregister exactly these callbacks before
    // the next Game instance registers its own - see
    // _teardownNetworkListeners() and NetworkClient.off().
    this._onNetworkInput = (data) => {
      this.enemy.remoteInput = data;
    };
    this._onNetworkDisconnected = () => {
      this.ui.showBanner('Opponent disconnected', 4000);
    };
    // The guest hit their own Surrender button - counts as a host win,
    // going through the exact same _endGame() flow a tower kill would.
    this._onNetworkSurrender = () => {
      this._endGame(true);
    };
    // The guest hit their own Rematch button - see _handleRematchClick().
    this._onNetworkRematchRequest = () => {
      this._opponentWantsRematch = true;
      this._updateRematchUi();
      if (this._localWantsRematch) this._startRematch();
    };

    this.networkClient.on('input', this._onNetworkInput);
    this.networkClient.on('disconnected', this._onNetworkDisconnected);
    this.networkClient.on('surrender', this._onNetworkSurrender);
    this.networkClient.on('rematch-request', this._onNetworkRematchRequest);
  }

  /**
   * Unregisters every listener this instance added to the shared
   * NetworkClient. Called right before a rematch hands control back
   * to the (still-connected) main menu, so the next Game/PvpGuestView
   * doesn't end up with this dead instance's callbacks still firing
   * alongside its own (NetworkClient.on() is additive, never
   * overwrites) - and also on a normal exit to menu, for the same
   * reason in case the player somehow starts another PVP match later.
   */
  _teardownNetworkListeners() {
    if (!this.networkClient) return;
    if (this._onNetworkInput) this.networkClient.off('input', this._onNetworkInput);
    if (this._onNetworkDisconnected) this.networkClient.off('disconnected', this._onNetworkDisconnected);
    if (this._onNetworkSurrender) this.networkClient.off('surrender', this._onNetworkSurrender);
    if (this._onNetworkRematchRequest) this.networkClient.off('rematch-request', this._onNetworkRematchRequest);
  }

  /**
   * Sends a throttled snapshot of everything the guest's browser needs
   * to render the match - it runs no simulation of its own, so this is
   * the only source of truth it has. Kept intentionally simple (plain
   * position/HP/direction data, no interpolation metadata) for a v1.
   */
  _broadcastPvpState() {
    this._pvpBroadcastTimer = (this._pvpBroadcastTimer || 0) + 1;
    // Every 3rd frame (~20/sec at 60fps) is plenty for a top-down MOBA
    // camera and keeps the message volume reasonable.
    if (this._pvpBroadcastTimer % 3 !== 0) return;

    this.networkClient.send('state', {
      gameTime: this.gameTime,
      hostCharacter: this.playerChar,
      guestCharacter: this.enemyChar,
      host: this._serializeHeroForSync(this.player),
      guest: this._serializeHeroForSync(this.enemy),
      hostTower: { hp: this.playerTower.hp, maxHp: this.playerTower.maxHp, isDestroyed: this.playerTower.isDestroyed, x: this.playerTower.x, y: this.playerTower.y },
      guestTower: { hp: this.enemyTower.hp, maxHp: this.enemyTower.maxHp, isDestroyed: this.enemyTower.isDestroyed, x: this.enemyTower.x, y: this.enemyTower.y },
      hostCreeps: this.playerCreepSpawner.creeps.map(c => ({ id: c.id, x: c.x, y: c.y, hp: c.hp, maxHp: c.maxHp, direction: c.direction, isMoving: c.isMoving })),
      guestCreeps: this.enemyCreepSpawner.creeps.map(c => ({ id: c.id, x: c.x, y: c.y, hp: c.hp, maxHp: c.maxHp, direction: c.direction, isMoving: c.isMoving })),
      hostKda: { kills: this.player.playerKills, deaths: this.player.deaths, assists: this.player.kills },
      guestKda: { kills: this.player.deaths, deaths: this.player.playerKills, assists: this.enemy.kills },
      // Every projectile/dash/stance visual for both heroes, so the
      // guest's screen shows the exact same skill effects the host does.
      hostSkill: this.skillManager.getSyncState(),
      guestSkill: this.enemy.skillManager.getSyncState(),
      // Basic-attack swoosh/impact effects (Combat -> EffectSystem)
      // spawned since the last broadcast - the guest replays these on
      // its own local EffectSystem so they fade independently instead
      // of relying on network-timed life values.
      effectSpawns: this.effects.drainRecentSpawns()
    });
  }

  /**
   * Plain-data snapshot of everything Player.draw()/Enemy.draw() read,
   * beyond position/HP - crowd control, shields, recall, and the
   * Benedetta passive - so the guest's puppets show every indicator
   * the host's own heroes do, not just where they are and how hurt.
   */
  _serializeHeroForSync(entity) {
    return {
      x: entity.x, y: entity.y, hp: entity.hp, maxHp: entity.maxHp,
      direction: entity.direction, isMoving: entity.isMoving, isDead: entity.isDead,
      character: entity.character,
      isStunned: entity.isStunned, isAirborne: entity.isAirborne,
      airborneDuration: entity.airborneDuration, airborneTimeRemaining: entity.airborneTimeRemaining,
      slowTimeRemaining: entity.slowTimeRemaining,
      shield: entity.shield, isInvulnerable: entity.isInvulnerable, isUntargetable: entity.isUntargetable,
      isRecalling: entity.isRecalling, recallTimer: entity.recallTimer, recallDuration: entity.recallDuration,
      attackFlashTimer: entity.attackFlashTimer, attackRange: entity.attackRange,
      respawnTimer: entity.respawnTimer,
      energy: entity.energy, maxEnergy: entity.maxEnergy,
      isChargingPassive: entity.isChargingPassive, isPassiveDashing: entity.isPassiveDashing,
      passiveAfterimages: entity.passiveAfterimages
    };
  }

  /**
   * Every enemy-side entity the player is currently allowed to attack
   * with basic attacks (click and space bar). Includes towers.
   */
  _getPlayerTargets() {
    const targets = [...this.enemyCreepSpawner.creeps];
    if (!this.enemyTower.isDestroyed) targets.push(this.enemyTower);
    if (!this.enemy.isDead && !this.enemy.isUntargetable) targets.push(this.enemy);
    return targets;
  }

  /**
   * Target list for skills (1/2/3) - excludes towers.
   * Skills can only target creeps and the enemy hero.
   */
  _getSkillTargets() {
    const targets = [...this.enemyCreepSpawner.creeps];
    if (!this.enemy.isDead && !this.enemy.isUntargetable) targets.push(this.enemy);
    return targets;
  }

  /**
   * Hero-on-hero damage under a tower immediately draws that tower's
   * aggro. Combat reports every damage event here, while Tower itself
   * verifies that the attacker is actually inside its range.
   */
  _notifyTowerOfHeroAttack(target, source) {
    if (target === this.enemy && source === this.player) {
      this.enemyTower.notifyHeroAttack(this.player, this.enemy);
    } else if (target === this.player && source === this.enemy) {
      this.playerTower.notifyHeroAttack(this.enemy, this.player);
    }
  }

  /**
   * Shared kill-crediting logic: only creep kills currently add to
   * the score (matching the existing basic-attack behavior), but
   * having one place to call keeps basic attacks and the skill
   * consistent if that ever changes.
   * @param {Object} target - the entity that was just killed
   */
  _onPlayerKill(target) {
    if (target instanceof Creep) {
      this.player.kills++;
    } else if (target === this.enemy) {
      this.player.playerKills++;
    }
  }

  /**
   * Reads any pending 1/2/3 press and asks the skill manager to
   * cast the matching slot.
   */
  _handleSkillInput() {
    // Discard buffered casts while dead or crowd-controlled so a keypress
    // during the lock cannot cast the moment the lock ends.
    if (this.player.isDead || this.player.isStunned) {
      for (let slot = 1; slot <= 3; slot++) inputHandler.consumeSkillCast(slot);
      return;
    }
    // Do not queue casts pressed during another skill's committed
    // animation. Discarding them prevents held keys from firing a
    // different ability the moment the current animation ends.
    if (this.skillManager.isCasting && this.skillManager.canCastDuringAnimation(2, this.player)) {
      // Gusion's Sword Waves return is the one recast allowed during a
      // skill dash. Consume every other slot so it cannot be queued to
      // fire when that animation ends.
      inputHandler.consumeSkillCast(1);
      const wantsSwordWavesReturn = inputHandler.consumeSkillCast(2);
      inputHandler.consumeSkillCast(3);
      if (wantsSwordWavesReturn) {
        const targets = this._getSkillTargets();
        this.skillManager.tryCast(2, this.player, this.effects, (target) => this._onPlayerKill(target), targets);
      }
      return;
    }

    if (this.skillManager.isCasting || this.player.isChargingPassive || this.player.isPassiveDashing) {
      for (let slot = 1; slot <= 3; slot++) {
        inputHandler.consumeSkillCast(slot);
      }
      return;
    }

    for (let slot = 1; slot <= 3; slot++) {
      if (inputHandler.consumeSkillCast(slot)) {
        const targets = this._getSkillTargets();
        const cast = this.skillManager.tryCast(slot, this.player, this.effects, (target) => this._onPlayerKill(target), targets);
        if (cast) {
          // Only one slot can begin casting per input frame.
          for (let remainingSlot = slot + 1; remainingSlot <= 3; remainingSlot++) {
            inputHandler.consumeSkillCast(remainingSlot);
          }
          return;
        }
      }
    }
  }

  /**
   * Handles B key press to start recall.
   */
  _handleRecallInput() {
    if (inputHandler.consumeRecall()) {
      const started = this.player.startRecall();
      if (started) {
        this.effects.spawnAttackEffect(this.player.x, this.player.y, this.player.x, this.player.y, '#81d4fa');
      }
    }
  }

  /**
   * Fires a one-time banner announcement the moment either tower
   * transitions from alive to destroyed, then queues up the
   * post-game results screen.
   */
  _checkTowerDestruction() {
    if (this._enemyTowerWasAlive && this.enemyTower.isDestroyed) {
      this._endGame(true);
    }
    this._enemyTowerWasAlive = !this.enemyTower.isDestroyed;

    if (this._playerTowerWasAlive && this.playerTower.isDestroyed) {
      this._endGame(false);
    }
    this._playerTowerWasAlive = !this.playerTower.isDestroyed;
  }

  /**
   * Surrender button - available in both AI mode and PVP (host or
   * guest side; see the matching handler in pvp-guest.js). Confirms
   * first since it's an immediate, irreversible loss.
   */
  _handleSurrenderClick() {
    if (this._matchDeciding || !this.isRunning) return;
    this._endGame(false);
  }

  /**
   * Lets the match play out for a few seconds after the deciding
   * tower falls (so the Victory/Defeat banner actually gets seen),
   * then freezes the game and shows the KDA results screen. Also
   * fires the Victory/Defeat banner itself (both locally and, in a
   * PVP match, over the network so the guest's screen shows the same
   * banner at the same time instead of jumping straight to the final
   * results screen) and guards against being queued up twice by e.g.
   * a tower falling right as the player also hits Surrender.
   * @param {boolean} playerWon
   */
  _endGame(playerWon) {
    if (this._matchDeciding) return;
    this._matchDeciding = true;

    this.ui.showBanner(playerWon ? 'Victory!' : 'Defeat!', 3000);

    // In a PVP match, the guest has no idea the match was just decided
    // otherwise - it never runs _checkTowerDestruction() itself (the
    // host is the only one simulating anything). Sent immediately
    // (rather than waiting for the final results screen below) so its
    // own Victory/Defeat banner appears in sync with the host's.
    if (this.networkClient) {
      this.networkClient.send('match-deciding', { hostWon: playerWon });
    }

    setTimeout(() => {
      this.isRunning = false; // freeze the final moment behind the results screen
      this._showGameResults(playerWon);
    }, 3000);
  }

  /**
   * Populates and reveals the post-game results screen with both
   * teams' KDA, then wires the Continue button to return to the
   * main menu. Enemy Kills/Deaths are mirrored from the player's
   * own stats (every player death is an enemy-team kill and vice
   * versa) since this is a 1v1 lane - only creep kills ("assists")
   * are tracked independently per side.
   * @param {boolean} playerWon
   */
  _showGameResults(playerWon) {
    const resultsScreen = document.getElementById('game-results');
    const titleEl = document.getElementById('results-title');

    titleEl.textContent = playerWon ? 'Victory!' : 'Defeat!';
    titleEl.classList.remove('victory', 'defeat');
    titleEl.classList.add(playerWon ? 'victory' : 'defeat');

    document.getElementById('results-player-kills').textContent = this.player.playerKills;
    document.getElementById('results-player-deaths').textContent = this.player.deaths;
    document.getElementById('results-player-assists').textContent = this.player.kills;

    document.getElementById('results-enemy-kills').textContent = this.player.deaths;
    document.getElementById('results-enemy-deaths').textContent = this.player.playerKills;
    document.getElementById('results-enemy-assists').textContent = this.enemy.kills;

    // Hero portraits - same sprite sheet + crop the character-select
    // cards use, so both teams get identical treatment here too.
    document.getElementById('results-player-portrait').style.backgroundImage = `url('${this.characterSprite}')`;
    document.getElementById('results-enemy-portrait').style.backgroundImage = `url('${this.enemySprite}')`;

    resultsScreen.classList.remove('hidden');

    // In a PVP match, the guest has no idea the match ended otherwise -
    // it never runs _checkTowerDestruction() itself (the host is the
    // only one simulating anything).
    if (this.networkClient) {
      this.networkClient.send('game-over', { hostWon: playerWon });
    }

    // Overwriting .onclick (rather than addEventListener) ensures only
    // one handler is ever attached, even across multiple matches.
    document.getElementById('results-continue-button').onclick = () => {
      resultsScreen.classList.add('hidden');
      this._returnToMainMenu();
    };

    // Rematch - PVP only. AI mode has no opponent to agree with, so
    // the button stays hidden and Continue is the only option there.
    const rematchButton = document.getElementById('results-rematch-button');
    const rematchStatus = document.getElementById('results-rematch-status');
    if (this.networkClient) {
      this._localWantsRematch = false;
      this._opponentWantsRematch = false;
      rematchButton.classList.remove('hidden');
      rematchButton.disabled = false;
      rematchButton.textContent = 'REMATCH';
      rematchStatus.classList.add('hidden');
      rematchButton.onclick = () => this._handleRematchClick();
    } else {
      rematchButton.classList.add('hidden');
      rematchStatus.classList.add('hidden');
    }
  }

  /**
   * Local half of the rematch handshake: marks that this side wants a
   * rematch, tells the opponent, and reflects the "waiting" state in
   * the UI. If the opponent already asked first, this immediately
   * satisfies both sides and starts the rematch.
   */
  _handleRematchClick() {
    if (this._localWantsRematch) return;
    this._localWantsRematch = true;
    this.networkClient.send('rematch-request', {});
    this._updateRematchUi();
    if (this._opponentWantsRematch) this._startRematch();
  }

  _updateRematchUi() {
    const rematchButton = document.getElementById('results-rematch-button');
    const rematchStatus = document.getElementById('results-rematch-status');
    if (!rematchButton || !rematchStatus) return;

    if (this._localWantsRematch) {
      rematchButton.disabled = true;
      rematchButton.textContent = 'REMATCH REQUESTED';
    }
    if (this._opponentWantsRematch && !this._localWantsRematch) {
      rematchStatus.textContent = 'Opponent wants a rematch! Click Rematch to accept.';
      rematchStatus.classList.remove('hidden');
    } else if (this._localWantsRematch && !this._opponentWantsRematch) {
      rematchStatus.textContent = 'Waiting for opponent to accept...';
      rematchStatus.classList.remove('hidden');
    }
  }

  /**
   * Both sides have now agreed - hands control back to the (still
   * connected) main menu so both players can pick a hero again,
   * exactly like the very first match, without re-hosting/re-joining.
   */
  _startRematch() {
    this.isRunning = false;
    this._teardownNetworkListeners();
    document.getElementById('game-results').classList.add('hidden');
    window.mainMenu.prepareRematch();
  }

  /**
   * Returns to the main menu after game ends. PVP matches go all the
   * way back to mode-select (the connection is now closed); AI mode
   * goes straight back to character-select like before.
   */
  _returnToMainMenu() {
    // Stop the game loop
    this.isRunning = false;

    this._teardownNetworkListeners();
    if (this.networkClient) {
      this.networkClient.disconnect();
      this.networkClient = null;
    }

    const gameContainer = document.getElementById('game-container');
    gameContainer.classList.remove('visible');

    if (this.pvpConfig) {
      document.getElementById('mode-select').classList.remove('hidden');
      document.getElementById('main-menu').classList.add('hidden');
    } else {
      document.getElementById('main-menu').classList.remove('hidden');
    }

    // Clean up the game instance
    this.player = null;
    this.enemy = null;
    this.playerTower = null;
    this.enemyTower = null;
    this.playerCreepSpawner = null;
    this.enemyCreepSpawner = null;
    this.skillManager = null;
    this.effects = null;
    this.camera = null;
    this.ui = null;
  }

  /**
   * Restarts the game by resetting all entities to their initial state.
   */
  _restartGame() {
    const laneY = this.mapHeight / 2;
    const playerBaseX = 300;
    const enemyBaseX = this.mapWidth - 300;

    // Reset game timer
    this.gameTime = 0;

    // Reset towers
    this.playerTower = new Tower(playerBaseX + 200, laneY, 'player');
    this.enemyTower = new Tower(enemyBaseX - 200, laneY, 'enemy');
    this._playerTowerWasAlive = true;
    this._enemyTowerWasAlive = true;
    this._matchDeciding = false;

    // Reset regeneration zones
    this.playerRegenZone = {
      x: playerBaseX,
      y: laneY,
      radius: 120,
      healRate: 30, // HP per second (increased for faster healing)
      color: 'rgba(76, 175, 80, 0.2)'
    };
    this.enemyRegenZone = {
      x: enemyBaseX,
      y: laneY,
      radius: 120,
      healRate: 15,
      color: 'rgba(244, 67, 54, 0.2)'
    };

    // Clear creep waves
    this.playerCreepSpawner = new CreepSpawner(this.lanePath, 'player', 8000, 3);
    const enemyLanePath = [
      { x: enemyBaseX, y: laneY }, // spawn behind enemy tower
      { x: playerBaseX, y: laneY }  // walk toward player base
    ];
    this.enemyCreepSpawner = new CreepSpawner(enemyLanePath, 'enemy', 8000, 3);

    // Reset enemy AI - spawns behind enemy tower (mirroring player spawn)
    this.enemy = new Enemy(enemyBaseX, laneY, this.mapBounds, this.enemySprite, this.enemyChar);
    if (this.networkClient) {
      this.enemy.isRemoteControlled = true;
    }

    // Reset player
    this.player.x = this.playerSpawnX;
    this.player.y = this.playerSpawnY;
    this.player.hp = this.player.maxHp;
    this.player.isDead = false;
    this.player.respawnTimer = 0;
    this.player.kills = 0; // creep kills
    this.player.playerKills = 0; // enemy hero kills
    this.player.deaths = 0; // total deaths
    this.player.cooldownRemaining = 0;
    this.player.isUntargetable = false;
    this.player.isStunned = false;
    this.player.stunTimeRemaining = 0;
    this.player.slowMultiplier = 1;
    this.player.slowTimeRemaining = 0;
    this.player.shield = 0;
    this.player.shieldTimeRemaining = 0;
    this.player.isInvulnerable = false;
    this.player.isRecalling = false;
    this.player.recallTimer = 0;
    this.player.energy = 0;
    this.player.isChargingPassive = false;
    this.player.isPassiveDashing = false;

    // Clear effects
    this.effects = new EffectSystem();

    // Reset the skill (clears cooldown and any bolts still in flight)
    this.skillManager = new SkillManager(this.playerChar);
  }

  /**
   * Handles both click attacks (targeted) and space bar attacks (nearest enemy).
   * Click attacks target a specific clicked enemy, space bar attacks the nearest
   * enemy within attack range.
   */
  _handleAttackInput(deltaTime) {
    // Also clear attack/charge input while dead; this prevents a held
    // Charge button from resuming a passive the moment she respawns.
    if (this.player.isDead) {
      inputHandler.consumeAttackPressed();
      inputHandler.consumeAttackReleased();
      inputHandler.consumeSpaceAttack();
      inputHandler.consumeClick();
      this.player.isChargingPassive = false;
      this.player.isPassiveDashing = false;
      this.player.passiveChargeHeldMs = 0;
      return;
    }
    // Benedetta replaces the ordinary attack control with a holdable
    // Charge button. A short release still uses the normal nearest-target
    // attack; a full bar release starts Elapsed Daytime instead.
    if (this.player.character === 'benedetta') {
      const pressed = inputHandler.consumeAttackPressed();
      const released = inputHandler.consumeAttackReleased();
      inputHandler.consumeSpaceAttack(); // Space uses the same hold/release path for this hero.
      if (pressed) this.player.beginPassiveCharge();
      const wasFullyCharged = this.player.energy >= this.player.maxEnergy;
      const candidates = this._getPlayerTargets();
      this.player.updateElapsedDaytime(deltaTime, inputHandler.isAttackHeld, released, candidates, this.effects,
        (target) => this._onPlayerKill(target));
      if (released && !wasFullyCharged) this._tryNearestBasicAttack(candidates);
    } else if (inputHandler.consumeAttackPressed()) {
      this._tryNearestBasicAttack(this._getPlayerTargets());
    }

    // Handle space bar basic attack (attacks nearest enemy in range)
    const spaceAttack = inputHandler.consumeSpaceAttack();
    if (spaceAttack) {
      this._tryNearestBasicAttack(this._getPlayerTargets());
    }

    // Handle click attack (targeted attack)
    const click = inputHandler.consumeClick();
    if (!click) return;

    // Screen-space click -> world-space click.
    const worldX = click.x + this.camera.x;
    const worldY = click.y + this.camera.y;

    // Gather every currently-attackable ENEMY entity. The player can
    // only attack the opposing faction, never their own tower/creeps.
    const candidates = this._getPlayerTargets();

    // Pick whichever candidate is closest to the click point, as
    // long as the click actually landed reasonably close to it.
    let closest = null;
    let closestDist = Infinity;
    const CLICK_TOLERANCE = 50; // px, generous hitbox for easy clicking

    for (const entity of candidates) {
      const d = Combat.distance(worldX, worldY, entity.x, entity.y);
      if (d <= CLICK_TOLERANCE && d < closestDist) {
        closest = entity;
        closestDist = d;
      }
    }

    if (!closest) return;

    const attackLanded = this.player.tryAttack(closest, this.effects);
    if (attackLanded && closest.hp <= 0) {
      this._onPlayerKill(closest);
    }
  }

  _tryNearestBasicAttack(candidates) {
    let closest = null;
    let closestDist = Infinity;
    for (const entity of candidates) {
      const d = Combat.distance(this.player.x, this.player.y, entity.x, entity.y);
      if (d <= this.player.attackRange && d < closestDist) {
        closest = entity;
        closestDist = d;
      }
    }
    if (!closest) return;
    const attackLanded = this.player.tryAttack(closest, this.effects);
    if (attackLanded && closest.hp <= 0) this._onPlayerKill(closest);
  }

  /**
   * Renders the current frame: background map, then entities,
   * all converted from world-space to screen-space via the camera.
   */
  _draw() {
    const ctx = this.ctx;

    // ---- Background (grass map) ----
    ctx.save();
    if (this.grassPattern) {
      // Draw the tiled pattern offset by the camera so it looks
      // like a seamless scrolling world instead of a fixed background.
      ctx.fillStyle = this.grassPattern;
      ctx.translate(-this.camera.x, -this.camera.y);
      ctx.fillRect(this.camera.x, this.camera.y, this.canvas.width, this.canvas.height);
      ctx.translate(this.camera.x, this.camera.y);
    } else {
      // Fallback flat color while the tile image is still loading.
      ctx.fillStyle = '#4a7d3a';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    ctx.restore();

    // ---- Map boundary outline (visual reference for the edge of the world) ----
    ctx.save();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.lineWidth = 6;
    ctx.strokeRect(
      this.camera.worldToScreenX(this.mapBounds.minX),
      this.camera.worldToScreenY(this.mapBounds.minY),
      this.mapWidth,
      this.mapHeight
    );
    ctx.restore();

    // ---- Lane path (dirt road creeps walk along) ----
    ctx.save();
    ctx.strokeStyle = 'rgba(120, 90, 60, 0.55)';
    ctx.lineWidth = 46;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(
      this.camera.worldToScreenX(this.lanePath[0].x),
      this.camera.worldToScreenY(this.lanePath[0].y)
    );
    for (let i = 1; i < this.lanePath.length; i++) {
      ctx.lineTo(
        this.camera.worldToScreenX(this.lanePath[i].x),
        this.camera.worldToScreenY(this.lanePath[i].y)
      );
    }
    ctx.stroke();
    ctx.restore();

    // ---- Regeneration zones ---- (healing areas behind each tower)
    if (!this.playerTower.isDestroyed) {
      ctx.save();
      ctx.fillStyle = this.playerRegenZone.color;
      ctx.beginPath();
      const playerRegenScreenX = this.camera.worldToScreenX(this.playerRegenZone.x);
      const playerRegenScreenY = this.camera.worldToScreenY(this.playerRegenZone.y);
      ctx.arc(playerRegenScreenX, playerRegenScreenY, this.playerRegenZone.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    if (!this.enemyTower.isDestroyed) {
      ctx.save();
      ctx.fillStyle = this.enemyRegenZone.color;
      ctx.beginPath();
      const enemyRegenScreenX = this.camera.worldToScreenX(this.enemyRegenZone.x);
      const enemyRegenScreenY = this.camera.worldToScreenY(this.enemyRegenZone.y);
      ctx.arc(enemyRegenScreenX, enemyRegenScreenY, this.enemyRegenZone.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // ---- Towers ---- (range ring only shown once the player gets close, to reduce clutter)
    const enemyTowerScreenX = this.camera.worldToScreenX(this.enemyTower.x);
    const enemyTowerScreenY = this.camera.worldToScreenY(this.enemyTower.y);
    const distToEnemyTower = Combat.distance(this.player.x, this.player.y, this.enemyTower.x, this.enemyTower.y);
    this.enemyTower.draw(ctx, enemyTowerScreenX, enemyTowerScreenY, distToEnemyTower <= this.enemyTower.attackRange * 1.6);

    const playerTowerScreenX = this.camera.worldToScreenX(this.playerTower.x);
    const playerTowerScreenY = this.camera.worldToScreenY(this.playerTower.y);
    const distToPlayerTower = Combat.distance(this.player.x, this.player.y, this.playerTower.x, this.playerTower.y);
    this.playerTower.draw(ctx, playerTowerScreenX, playerTowerScreenY, distToPlayerTower <= this.playerTower.attackRange * 1.6);

    // ---- Creeps (both waves) ----
    this.enemyCreepSpawner.draw(ctx, this.camera);
    this.playerCreepSpawner.draw(ctx, this.camera);

    // ---- Enemy AI ----
    const enemyScreenX = this.camera.worldToScreenX(this.enemy.x);
    const enemyScreenY = this.camera.worldToScreenY(this.enemy.y);
    this.enemy.draw(ctx, enemyScreenX, enemyScreenY);

    // ---- Enemy skill projectiles ----
    this.enemy.skillManager.draw(ctx, this.camera);

    // ---- Player ----
    const screenX = this.camera.worldToScreenX(this.player.x);
    const screenY = this.camera.worldToScreenY(this.player.y);
    this.player.draw(ctx, screenX, screenY);

    // ---- Skill projectiles ----
    this.skillManager.draw(ctx, this.camera);

    // ---- Combat effects (drawn last so they appear on top of everything) ----
    this.effects.draw(ctx, this.camera);

    // ---- Minimap (both PC and Android modes) ----
    if (this.minimapCtx) {
      this._drawMinimap();
    }
  }

  /**
   * Renders a simplified top-down view of the whole map onto the
   * small minimap canvas: both towers, both creep waves, both heroes,
   * and a rectangle showing what the main camera currently sees.
   * World-space coordinates are scaled directly to the minimap's
   * pixel size (independent of the main camera/zoom).
   */
  _drawMinimap() {
    const mctx = this.minimapCtx;
    const size = this.minimapCanvas.width; // square canvas
    const scaleX = size / this.mapWidth;
    const scaleY = size / this.mapHeight;
    const toMiniX = (worldX) => worldX * scaleX;
    const toMiniY = (worldY) => worldY * scaleY;

    // Background + lane.
    mctx.fillStyle = '#2f4a24';
    mctx.fillRect(0, 0, size, size);
    mctx.strokeStyle = 'rgba(150, 115, 75, 0.7)';
    mctx.lineWidth = 4;
    mctx.beginPath();
    mctx.moveTo(toMiniX(this.lanePath[0].x), toMiniY(this.lanePath[0].y));
    mctx.lineTo(toMiniX(this.lanePath[1].x), toMiniY(this.lanePath[1].y));
    mctx.stroke();

    // Towers.
    if (!this.playerTower.isDestroyed) {
      mctx.fillStyle = '#42a5f5';
      mctx.fillRect(toMiniX(this.playerTower.x) - 3, toMiniY(this.playerTower.y) - 3, 6, 6);
    }
    if (!this.enemyTower.isDestroyed) {
      mctx.fillStyle = '#ef5350';
      mctx.fillRect(toMiniX(this.enemyTower.x) - 3, toMiniY(this.enemyTower.y) - 3, 6, 6);
    }

    // Creeps - small dots, cheap enough to draw every one.
    mctx.fillStyle = '#90caf9';
    for (const creep of this.playerCreepSpawner.creeps) {
      mctx.beginPath();
      mctx.arc(toMiniX(creep.x), toMiniY(creep.y), 2, 0, Math.PI * 2);
      mctx.fill();
    }
    mctx.fillStyle = '#ef9a9a';
    for (const creep of this.enemyCreepSpawner.creeps) {
      mctx.beginPath();
      mctx.arc(toMiniX(creep.x), toMiniY(creep.y), 2, 0, Math.PI * 2);
      mctx.fill();
    }

    // Enemy hero.
    if (!this.enemy.isDead) {
      mctx.fillStyle = '#ff1744';
      mctx.beginPath();
      mctx.arc(toMiniX(this.enemy.x), toMiniY(this.enemy.y), 4, 0, Math.PI * 2);
      mctx.fill();
    }

    // Player - drawn last/largest so it's always easy to find.
    mctx.fillStyle = '#ffd54f';
    mctx.beginPath();
    mctx.arc(toMiniX(this.player.x), toMiniY(this.player.y), 5, 0, Math.PI * 2);
    mctx.fill();
    mctx.strokeStyle = '#ffffff';
    mctx.lineWidth = 1.5;
    mctx.stroke();

    // Camera viewport rectangle, so it's clear what part of the map is on-screen.
    mctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    mctx.lineWidth = 1;
    mctx.strokeRect(
      toMiniX(this.camera.x),
      toMiniY(this.camera.y),
      this.camera.viewWidth * scaleX,
      this.camera.viewHeight * scaleY
    );
  }
}
