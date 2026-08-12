/**
 * pvp-guest.js
 * ------------------------------------------------------
 * The "guest" side of a PvP match. Unlike Game (used by both AI mode
 * and the PvP host), this class runs NO simulation at all - the host's
 * browser is the single source of truth for everything (positions, HP,
 * creeps, towers, who's alive, and every skill effect). This class just:
 *   1. Reads the guest's local input every frame and ships it to the
 *      host over the network (movement, attack press/hold/release,
 *      skill casts, recall).
 *   2. Renders whatever state snapshot the host most recently sent.
 *
 * It reuses the real Player/Enemy/Tower/SkillManager classes purely as
 * rendering "puppets" - their sprites, draw() methods, and skill visuals
 * look identical to the host's, but their fields are overwritten
 * directly from network data every frame instead of being driven by
 * their own update() logic. Creeps are drawn as simple colored dots
 * rather than full puppets, since there can be several at once and
 * they're low-detail units anyway (matches the same simplification the
 * minimap already uses).
 * ------------------------------------------------------
 */
class PvpGuestView {
  /**
   * @param {string} mySpriteSrc - the guest's own chosen character sprite
   * @param {NetworkClient} networkClient
   */
  constructor(mySpriteSrc, networkClient) {
    this.networkClient = networkClient;

    this.canvas = document.getElementById('gameCanvas');
    this.ctx = this.canvas.getContext('2d');
    this._resizeCanvas();
    window.addEventListener('resize', () => this._resizeCanvas());

    this.mapWidth = 3000;
    this.mapHeight = 3000;
    this.mapBounds = { minX: 0, minY: 0, maxX: this.mapWidth, maxY: this.mapHeight };

    this.grassTile = new Image();
    this.grassTile.src = 'assets/map/grass_tile.png';
    this.grassPattern = null;
    this.grassTile.onload = () => {
      this.grassPattern = this.ctx.createPattern(this.grassTile, 'repeat');
    };

    // Same character-detection rule Player/Game use, so the guest's own
    // puppet and skill kit always match whichever hero they picked.
    const CHARACTERS = ['gusion', 'hayabusa', 'benedetta', 'chou'];
    this.myCharacter = CHARACTERS.find(c => mySpriteSrc.includes(c)) || 'gusion';

    // Rendering puppets - real classes, real sprites, but never .update()'d.
    // "host" is always the player who clicked Host (left/blue side);
    // "guest" is always this browser's own hero (right/red side), even
    // though visually it's just whichever puppet is on the right.
    // The host puppet's sprite/character are corrected as soon as the
    // first state snapshot tells us who the host actually picked.
    this.hostPuppet = new Player(300, 1500, this.mapBounds, 'assets/player/gusion.png');
    this.guestPuppet = new Enemy(2700, 1500, this.mapBounds, mySpriteSrc, this.myCharacter);
    this.hostTowerPuppet = new Tower(500, 1500, 'player');
    this.guestTowerPuppet = new Tower(2500, 1500, 'enemy');
    this._hostCharacterKnown = null;

    // Purely visual skill managers - mirror the host's projectiles,
    // dashes, and stance rings from synced state. Never cast/update
    // locally; see SkillManager.applySyncState() in skill.js.
    this.guestSkillManager = new SkillManager(this.myCharacter);
    this.hostSkillManager = null; // created lazily once we learn the host's character

    // Basic-attack swoosh/impact effects - a purely local EffectSystem
    // fed by "spawn" events relayed from the host's own (see
    // _applyState/effectSpawns below), so they fade on this browser's
    // own clock exactly like the host's do, instead of never appearing.
    this.effects = new EffectSystem();

    this.hostCreeps = [];
    this.guestCreeps = [];
    // Real Creep instances kept purely for rendering (sprite + health
    // bar + slow/stun icons via Creep.prototype.draw()), the same
    // "real class as a puppet" pattern used for the heroes/towers -
    // keyed by the network id so each creep's walk-cycle animator
    // persists smoothly across state updates instead of restarting
    // from scratch (and instead of falling back to a plain color dot).
    this.hostCreepPuppets = new Map();
    this.guestCreepPuppets = new Map();
    this.hostCreepPuppetList = [];
    this.guestCreepPuppetList = [];
    this.hostKda = { kills: 0, deaths: 0, assists: 0 };
    this.guestKda = { kills: 0, deaths: 0, assists: 0 };
    this.gameTime = 0;
    this.connectedToHost = true;
    this.matchEnded = false;
    this.guestWon = false;
    this.isRunning = true;

    this.camera = new Camera(this.canvas.width, this.canvas.height, this.mapBounds);

    // Same stats-panel elements the normal UIManager uses, updated
    // directly here since this view has no real Player to hand to it.
    this.fpsElement = document.getElementById('fps-value');
    this.timeElement = document.getElementById('game-time');
    this.hpElement = document.getElementById('player-hp');
    this.maxHpElement = document.getElementById('player-max-hp');
    this.kdaElement = document.getElementById('player-kda');
    this.recallStatusElement = document.getElementById('recall-status');
    this.attackButton = document.getElementById('attack-button');
    this.energyBar = document.getElementById('energy-bar');
    this.energyBarFill = document.getElementById('energy-bar-fill');
    // Upper-middle kills-only scoreboard - "you" is always this
    // browser's own hero (guestKda), "enemy" is always the host's.
    this.scoreboardPlayerKillsElement = document.getElementById('scoreboard-player-kills');
    this.scoreboardEnemyKillsElement = document.getElementById('scoreboard-enemy-kills');
    this._fpsTimer = 0;
    this._fpsFrames = 0;

    // Only used for its skill-bar DOM refs + _updateSkillSlot() helper -
    // everything else in _updateStatsPanel() is hand-rolled above instead,
    // since this view has no real local Player to hand a full UIManager.
    this.ui = new UIManager();

    // Minimap - same simplified top-down view the host draws, built from
    // puppet/broadcast data instead of live simulation entities.
    this.minimapCanvas = document.getElementById('minimap-canvas');
    this.minimapCtx = this.minimapCanvas ? this.minimapCanvas.getContext('2d') : null;
    this.lanePath = [{ x: 300, y: 1500 }, { x: 2700, y: 1500 }];

    networkClient.on('state', this._onState = (data) => this._applyState(data));
    networkClient.on('disconnected', this._onDisconnected = () => this._handleDisconnect());
    networkClient.on('peer-left', this._onPeerLeft = () => this._handleDisconnect());
    networkClient.on('game-over', this._onGameOver = (data) => this._handleGameOver(data));
    // Sent immediately when the host decides the outcome (tower down
    // or either side surrendering) - shows the same Victory/Defeat
    // banner the host sees, in sync, well before the final results
    // screen ('game-over', below) arrives ~3s later.
    networkClient.on('match-deciding', this._onMatchDeciding = (data) => this._handleMatchDeciding(data));
    // The host hit their own Rematch button - see _handleRematchClick().
    networkClient.on('rematch-request', this._onRematchRequest = () => this._handleRematchRequestReceived());

    // Rematch handshake - both sides must click their own Rematch
    // button (in either order) before _startRematch() fires.
    this._localWantsRematch = false;
    this._opponentWantsRematch = false;

    // Surrender button - same UX as the host's: confirm, then tell the
    // host, who resolves the match through its own single _endGame()
    // path so both sides end up perfectly in sync.
    const surrenderButton = document.getElementById('surrender-button');
    if (surrenderButton) {
      surrenderButton.onclick = () => this._handleSurrenderClick();
    }

    // Only the "connection lost" case still uses a click-anywhere canvas
    // overlay (there's no host left to resolve a normal Continue flow);
    // a real match end now uses the same #game-results screen as the host.
    this._returnToMenuHandler = () => {
      if (!this.connectedToHost) this._returnToMenu();
    };
    this.canvas.addEventListener('click', this._returnToMenuHandler);

    this.lastTimestamp = 0;
    requestAnimationFrame((t) => this._loop(t));
  }

  _resizeCanvas() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    if (this.camera) this.camera.resize(this.canvas.width, this.canvas.height);
  }

  /**
   * Copies the host's latest snapshot onto the render puppets and the
   * visual-only skill managers. Called every time a 'state' message
   * arrives (throttled on the host's side to ~20/sec), not every
   * render frame.
   */
  _applyState(data) {
    this.gameTime = data.gameTime;

    // The host's sprite/character are only known once the first snapshot
    // arrives (they depend on the host's own character pick). Swap the
    // puppet's sheet the moment it differs from what we last loaded.
    if (data.hostCharacter && data.hostCharacter !== this._hostCharacterKnown) {
      this._hostCharacterKnown = data.hostCharacter;
      this.hostPuppet.character = data.hostCharacter;
      this.hostPuppet.sheetImage = new Image();
      this.hostPuppet.sheetImage.src = `assets/player/${data.hostCharacter}.png`;
      this.hostPuppet.animator = new SpriteAnimator(
        this.hostPuppet.sheetImage, 64, 64,
        { down: 0, left: 1, right: 2, up: 3 }, 4, 110
      );
      this.hostSkillManager = new SkillManager(data.hostCharacter);
    }

    Object.assign(this.hostPuppet, data.host);
    Object.assign(this.guestPuppet, data.guest);

    this.hostTowerPuppet.hp = data.hostTower.hp;
    this.hostTowerPuppet.maxHp = data.hostTower.maxHp;
    this.hostTowerPuppet.isDestroyed = data.hostTower.isDestroyed;
    this.guestTowerPuppet.hp = data.guestTower.hp;
    this.guestTowerPuppet.maxHp = data.guestTower.maxHp;
    this.guestTowerPuppet.isDestroyed = data.guestTower.isDestroyed;

    this.hostCreeps = data.hostCreeps;
    this.guestCreeps = data.guestCreeps;
    this.hostCreepPuppetList = this._syncCreepPuppets(this.hostCreepPuppets, 'player', data.hostCreeps);
    this.guestCreepPuppetList = this._syncCreepPuppets(this.guestCreepPuppets, 'enemy', data.guestCreeps);
    this.hostKda = data.hostKda;
    this.guestKda = data.guestKda;

    // Every projectile/dash/stance the host is currently showing -
    // applied onto our own inert SkillManager instances purely for draw().
    if (this.hostSkillManager && data.hostSkill) this.hostSkillManager.applySyncState(data.hostSkill);
    if (data.guestSkill) this.guestSkillManager.applySyncState(data.guestSkill);

    // Basic-attack effects the host spawned since its last broadcast -
    // replayed here so they fade independently on this browser's own
    // clock. drainRecentSpawns() is discarded (never sent anywhere) -
    // just called so this local EffectSystem's own queue doesn't grow
    // forever over a long match.
    for (const spawn of (data.effectSpawns || [])) {
      this.effects.spawnAttackEffect(spawn.fromX, spawn.fromY, spawn.toX, spawn.toY, spawn.color);
    }
    this.effects.drainRecentSpawns();
  }

  _handleDisconnect() {
    this.connectedToHost = false;
  }

  /**
   * Reconciles this side's live Creep puppets against the latest
   * network snapshot, matched by id (see the `id` field creep.js now
   * assigns every Creep). Reuses existing puppets in place (so each
   * one's SpriteAnimator keeps its current walk-cycle frame instead of
   * visibly resetting every ~50ms broadcast tick) rather than throwing
   * everything away and rebuilding it - only creates a new puppet for
   * a newly-spawned creep, and drops one once its id stops appearing
   * (died or reached the end of the lane).
   * @param {Map<number, Creep>} map - persistent puppet store (host or guest side)
   * @param {string} faction - 'player' or 'enemy', for sprite sheet + bar color
   * @param {Array} creepDataArray - this frame's plain-data creeps from the host
   * @returns {Creep[]} the current puppets, in network order, ready to draw
   */
  _syncCreepPuppets(map, faction, creepDataArray) {
    const seenIds = new Set();
    const puppets = [];
    for (const data of creepDataArray) {
      seenIds.add(data.id);
      let puppet = map.get(data.id);
      if (!puppet) {
        // The path is never walked (this puppet's own update() is
        // never called - the host owns all movement), so a two-point
        // placeholder is enough; only the sprite/animator/health-bar
        // machinery from the real Creep class is actually used here.
        puppet = new Creep([{ x: data.x, y: data.y }, { x: data.x, y: data.y }], faction);
        map.set(data.id, puppet);
      }
      puppet.x = data.x;
      puppet.y = data.y;
      puppet.hp = data.hp;
      puppet.maxHp = data.maxHp;
      puppet.direction = data.direction;
      puppet.isMoving = data.isMoving;
      puppets.push(puppet);
    }
    for (const id of Array.from(map.keys())) {
      if (!seenIds.has(id)) map.delete(id);
    }
    return puppets;
  }

  /**
   * The host just decided the match outcome (tower fell or someone hit
   * Surrender) but hasn't shown its own results screen yet - shows the
   * same Victory/Defeat banner toast the host does, at the same time,
   * instead of the guest jumping straight to the final results screen
   * a few seconds later with no warning.
   */
  _handleMatchDeciding(data) {
    const guestWon = !data.hostWon;
    this.ui.showBanner(guestWon ? 'Victory!' : 'Defeat!', 3000);
  }

  /**
   * Surrender button - confirms, then hands the decision to the host
   * (the single source of truth for match state) rather than ending
   * the match locally. The host's own _endGame() flow then broadcasts
   * 'match-deciding' (banner) and later 'game-over' (results screen)
   * back to this browser like any other match end.
   */
  _handleSurrenderClick() {
    if (this.matchEnded || !this.connectedToHost) return;
    this.networkClient.send('surrender', {});
  }

  /**
   * The host just told us the match is over. data.hostWon is from the
   * HOST's perspective, so this browser (the guest) won iff the host
   * didn't. Shows the same #game-results screen (with hero portraits
   * and KDA) the host itself sees.
   */
  _handleGameOver(data) {
    this.matchEnded = true;
    this.guestWon = !data.hostWon;
    this._showResultsScreen();
  }

  /**
   * Populates and reveals the shared post-game results screen. From the
   * guest's own point of view "Your Team" is this browser's hero
   * (guestPuppet/guestKda) and "Enemy Team" is the host's
   * (hostPuppet/hostKda) - the same self-vs-opponent framing the host's
   * own screen uses, just mirrored.
   */
  _showResultsScreen() {
    const resultsScreen = document.getElementById('game-results');
    const titleEl = document.getElementById('results-title');

    titleEl.textContent = this.guestWon ? 'Victory!' : 'Defeat!';
    titleEl.classList.remove('victory', 'defeat');
    titleEl.classList.add(this.guestWon ? 'victory' : 'defeat');

    document.getElementById('results-player-kills').textContent = this.guestKda.kills;
    document.getElementById('results-player-deaths').textContent = this.guestKda.deaths;
    document.getElementById('results-player-assists').textContent = this.guestKda.assists;

    document.getElementById('results-enemy-kills').textContent = this.hostKda.kills;
    document.getElementById('results-enemy-deaths').textContent = this.hostKda.deaths;
    document.getElementById('results-enemy-assists').textContent = this.hostKda.assists;

    document.getElementById('results-player-portrait').style.backgroundImage = `url('${this.guestPuppet.sheetImage.src}')`;
    document.getElementById('results-enemy-portrait').style.backgroundImage = `url('${this.hostPuppet.sheetImage.src}')`;

    resultsScreen.classList.remove('hidden');

    // Overwriting .onclick (rather than addEventListener) ensures only
    // one handler is ever attached, same as the host's version.
    document.getElementById('results-continue-button').onclick = () => {
      resultsScreen.classList.add('hidden');
      this._returnToMenu();
    };

    // Rematch - always PVP here (this whole view only exists in PVP).
    const rematchButton = document.getElementById('results-rematch-button');
    const rematchStatus = document.getElementById('results-rematch-status');
    this._localWantsRematch = false;
    this._opponentWantsRematch = false;
    rematchButton.classList.remove('hidden');
    rematchButton.disabled = false;
    rematchButton.textContent = 'REMATCH';
    rematchStatus.classList.add('hidden');
    rematchButton.onclick = () => this._handleRematchClick();
  }

  /**
   * Local half of the rematch handshake: marks that this side wants a
   * rematch, tells the host, and reflects the "waiting" state in the
   * UI. If the host already asked first, this immediately satisfies
   * both sides and starts the rematch.
   */
  _handleRematchClick() {
    if (this._localWantsRematch || !this.connectedToHost) return;
    this._localWantsRematch = true;
    this.networkClient.send('rematch-request', {});
    this._updateRematchUi();
    if (this._opponentWantsRematch) this._startRematch();
  }

  _handleRematchRequestReceived() {
    this._opponentWantsRematch = true;
    this._updateRematchUi();
    if (this._localWantsRematch) this._startRematch();
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
    this.canvas.removeEventListener('click', this._returnToMenuHandler);
    this._teardownNetworkListeners();
    document.getElementById('game-results').classList.add('hidden');
    window.mainMenu.prepareRematch();
  }

  /**
   * Unregisters every listener this instance added to the shared
   * NetworkClient - see the matching method/comment in game.js.
   * Needed before both a rematch and a normal menu return, since
   * NetworkClient.on() is additive and never overwrites.
   */
  _teardownNetworkListeners() {
    if (this._onState) this.networkClient.off('state', this._onState);
    if (this._onDisconnected) this.networkClient.off('disconnected', this._onDisconnected);
    if (this._onPeerLeft) this.networkClient.off('peer-left', this._onPeerLeft);
    if (this._onGameOver) this.networkClient.off('game-over', this._onGameOver);
    if (this._onMatchDeciding) this.networkClient.off('match-deciding', this._onMatchDeciding);
    if (this._onRematchRequest) this.networkClient.off('rematch-request', this._onRematchRequest);
  }

  /**
   * Disconnects and hands control back to the main menu (mode-select,
   * same as how a PVP host's Game routes back after a match).
   */
  _returnToMenu() {
    this.isRunning = false;
    this.canvas.removeEventListener('click', this._returnToMenuHandler);
    this._teardownNetworkListeners();
    this.networkClient.disconnect();

    document.getElementById('game-results').classList.add('hidden');
    document.getElementById('game-container').classList.remove('visible');
    document.getElementById('main-menu').classList.add('hidden');
    document.getElementById('mode-select').classList.remove('hidden');
  }

  _loop(timestamp) {
    if (this.isRunning === false) return;

    const deltaTime = timestamp - this.lastTimestamp || 0;
    this.lastTimestamp = timestamp;

    // A single bad frame (e.g. a malformed network snapshot) must never
    // permanently freeze this screen - without a request for the next
    // frame below, requestAnimationFrame stops firing forever and the
    // player sees a dead canvas until they reload. Log and keep going.
    try {
      this._sendInput();

      // Puppets aren't updated for movement (the host owns that), but
      // their sprite animation still needs advancing frame-to-frame so
      // walking actually looks like walking instead of a frozen pose.
      this.hostPuppet.animator.update(deltaTime, this.hostPuppet.direction, this.hostPuppet.isMoving);
      this.guestPuppet.animator.update(deltaTime, this.guestPuppet.direction, this.guestPuppet.isMoving);
      for (const creep of this.hostCreepPuppetList) creep.animator.update(deltaTime, creep.direction, creep.isMoving);
      for (const creep of this.guestCreepPuppetList) creep.animator.update(deltaTime, creep.direction, creep.isMoving);
      this.effects.update(deltaTime);

      // Afterimages (Benedetta's passive dash) fade over real time even
      // between state snapshots, same as the host's own rendering.
      for (const img of this.hostPuppet.passiveAfterimages || []) img.life -= deltaTime;
      for (const img of this.guestPuppet.passiveAfterimages || []) img.life -= deltaTime;

      this.camera.follow({ x: this.guestPuppet.x, y: this.guestPuppet.y });

      this._draw();
      this._updateStatsPanel(deltaTime);
    } catch (err) {
      console.error('PvpGuestView frame error (recovered):', err);
    }

    requestAnimationFrame((t) => this._loop(t));
  }

  /**
   * Reads local input and ships it to the host. The host resolves
   * everything authoritatively (movement, hit-testing, damage) - this
   * side never touches game state directly. Sends the same
   * pressed/held/released shape the local player's own attack button
   * uses, so Benedetta's Charge-and-release passive works identically
   * whether she's played locally or over the network.
   */
  _sendInput() {
    const move = inputHandler.getMovementVector();
    const clicked = inputHandler.consumeClick();
    const spaceAttack = inputHandler.consumeSpaceAttack();
    const pressed = inputHandler.consumeAttackPressed();
    const released = inputHandler.consumeAttackReleased();
    const recallPressed = inputHandler.consumeRecall();
    const skillPressed = [1, 2, 3].map(slot => inputHandler.consumeSkillCast(slot));

    this.networkClient.send('input', {
      moveX: move.x,
      moveY: move.y,
      attackPressed: !!clicked || spaceAttack || pressed,
      attackHeld: inputHandler.isAttackHeld,
      attackReleased: released,
      skillPressed,
      recallPressed
    });
  }

  _draw() {
    const ctx = this.ctx;
    ctx.save();
    if (this.grassPattern) {
      ctx.fillStyle = this.grassPattern;
      ctx.translate(-this.camera.x, -this.camera.y);
      ctx.fillRect(this.camera.x, this.camera.y, this.canvas.width, this.canvas.height);
      ctx.translate(this.camera.x, this.camera.y);
    } else {
      ctx.fillStyle = '#4a7d3a';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    ctx.restore();

    // Lane.
    ctx.save();
    ctx.strokeStyle = 'rgba(120, 90, 60, 0.55)';
    ctx.lineWidth = 46;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(this.camera.worldToScreenX(300), this.camera.worldToScreenY(1500));
    ctx.lineTo(this.camera.worldToScreenX(2700), this.camera.worldToScreenY(1500));
    ctx.stroke();
    ctx.restore();

    // Regeneration zones (healing areas behind each tower) - static
    // geometry derived from the same map dimensions/base positions
    // Game uses, so no network sync is needed; each one just fades out
    // once its tower falls, matching the host's own screen.
    if (!this.hostTowerPuppet.isDestroyed) {
      ctx.save();
      ctx.fillStyle = 'rgba(76, 175, 80, 0.2)';
      ctx.beginPath();
      ctx.arc(this.camera.worldToScreenX(this.lanePath[0].x), this.camera.worldToScreenY(this.lanePath[0].y), 120, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    if (!this.guestTowerPuppet.isDestroyed) {
      ctx.save();
      ctx.fillStyle = 'rgba(244, 67, 54, 0.2)';
      ctx.beginPath();
      ctx.arc(this.camera.worldToScreenX(this.lanePath[1].x), this.camera.worldToScreenY(this.lanePath[1].y), 120, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Towers - range ring shown once the guest's OWN hero gets close,
    // the same viewer-relative rule the host's screen uses for itself.
    if (!this.hostTowerPuppet.isDestroyed) {
      const distToHostTower = Combat.distance(this.guestPuppet.x, this.guestPuppet.y, this.hostTowerPuppet.x, this.hostTowerPuppet.y);
      this.hostTowerPuppet.draw(
        ctx, this.camera.worldToScreenX(this.hostTowerPuppet.x), this.camera.worldToScreenY(this.hostTowerPuppet.y),
        distToHostTower <= this.hostTowerPuppet.attackRange * 1.6
      );
    }
    if (!this.guestTowerPuppet.isDestroyed) {
      const distToGuestTower = Combat.distance(this.guestPuppet.x, this.guestPuppet.y, this.guestTowerPuppet.x, this.guestTowerPuppet.y);
      this.guestTowerPuppet.draw(
        ctx, this.camera.worldToScreenX(this.guestTowerPuppet.x), this.camera.worldToScreenY(this.guestTowerPuppet.y),
        distToGuestTower <= this.guestTowerPuppet.attackRange * 1.6
      );
    }

    // Creeps - real sprite puppets (see _syncCreepPuppets), not dots.
    this._drawCreeps(this.hostCreepPuppetList);
    this._drawCreeps(this.guestCreepPuppetList);

    // Heroes + their skill effects, in the same back-to-front order the
    // host uses (opponent's hero/skills, then your own). draw() is called
    // unconditionally even while dead - Player/Enemy already fade the
    // sprite and show "Respawning in Xs" internally, same as the host's
    // own screen; gating this on !isDead would just make dead heroes
    // vanish entirely instead of showing that countdown.
    this.hostPuppet.draw(ctx, this.camera.worldToScreenX(this.hostPuppet.x), this.camera.worldToScreenY(this.hostPuppet.y));
    if (this.hostSkillManager) this.hostSkillManager.draw(ctx, this.camera);

    this.guestPuppet.draw(ctx, this.camera.worldToScreenX(this.guestPuppet.x), this.camera.worldToScreenY(this.guestPuppet.y));
    this.guestSkillManager.draw(ctx, this.camera);

    // Combat effects (drawn last so they appear on top of everything,
    // same as the host's own screen).
    this.effects.draw(ctx, this.camera);

    if (!this.connectedToHost) {
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.fillStyle = '#ef5350';
      ctx.font = 'bold 28px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Connection to host lost', this.canvas.width / 2, this.canvas.height / 2);
      ctx.font = '14px sans-serif';
      ctx.fillStyle = '#fff';
      ctx.fillText('Click anywhere to return to the menu', this.canvas.width / 2, this.canvas.height / 2 + 32);
      ctx.restore();
    }

    if (this.minimapCtx) {
      this._drawMinimap();
    }
  }

  /**
   * Same simplified top-down view as the host's minimap, just built
   * from puppet/broadcast data instead of live simulation entities.
   * "Me" (the guest's own hero) is always the gold dot, matching how
   * the host's minimap always highlights its own player in gold too.
   */
  _drawMinimap() {
    const mctx = this.minimapCtx;
    const size = this.minimapCanvas.width;
    const scaleX = size / this.mapWidth;
    const scaleY = size / this.mapHeight;
    const toMiniX = (worldX) => worldX * scaleX;
    const toMiniY = (worldY) => worldY * scaleY;

    mctx.fillStyle = '#2f4a24';
    mctx.fillRect(0, 0, size, size);
    mctx.strokeStyle = 'rgba(150, 115, 75, 0.7)';
    mctx.lineWidth = 4;
    mctx.beginPath();
    mctx.moveTo(toMiniX(this.lanePath[0].x), toMiniY(this.lanePath[0].y));
    mctx.lineTo(toMiniX(this.lanePath[1].x), toMiniY(this.lanePath[1].y));
    mctx.stroke();

    if (!this.hostTowerPuppet.isDestroyed) {
      mctx.fillStyle = '#42a5f5';
      mctx.fillRect(toMiniX(this.hostTowerPuppet.x) - 3, toMiniY(this.hostTowerPuppet.y) - 3, 6, 6);
    }
    if (!this.guestTowerPuppet.isDestroyed) {
      mctx.fillStyle = '#ef5350';
      mctx.fillRect(toMiniX(this.guestTowerPuppet.x) - 3, toMiniY(this.guestTowerPuppet.y) - 3, 6, 6);
    }

    mctx.fillStyle = '#90caf9';
    for (const creep of this.hostCreeps) {
      mctx.beginPath();
      mctx.arc(toMiniX(creep.x), toMiniY(creep.y), 2, 0, Math.PI * 2);
      mctx.fill();
    }
    mctx.fillStyle = '#ef9a9a';
    for (const creep of this.guestCreeps) {
      mctx.beginPath();
      mctx.arc(toMiniX(creep.x), toMiniY(creep.y), 2, 0, Math.PI * 2);
      mctx.fill();
    }

    if (!this.hostPuppet.isDead) {
      mctx.fillStyle = '#ff1744';
      mctx.beginPath();
      mctx.arc(toMiniX(this.hostPuppet.x), toMiniY(this.hostPuppet.y), 4, 0, Math.PI * 2);
      mctx.fill();
    }

    mctx.fillStyle = '#ffd54f';
    mctx.beginPath();
    mctx.arc(toMiniX(this.guestPuppet.x), toMiniY(this.guestPuppet.y), 5, 0, Math.PI * 2);
    mctx.fill();
    mctx.strokeStyle = '#ffffff';
    mctx.lineWidth = 1.5;
    mctx.stroke();

    mctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    mctx.lineWidth = 1;
    mctx.strokeRect(
      toMiniX(this.camera.x),
      toMiniY(this.camera.y),
      this.camera.viewWidth * scaleX,
      this.camera.viewHeight * scaleY
    );
  }

  /**
   * Draws real creep sprites (walk-cycle animation, faction sheet,
   * health bar, slow/stun icons) via the actual Creep.prototype.draw()
   * - the same rendering code the host uses for its own creeps -
   * instead of a plain color dot placeholder.
   */
  _drawCreeps(creepPuppets) {
    const ctx = this.ctx;
    for (const creep of creepPuppets) {
      const sx = this.camera.worldToScreenX(creep.x);
      const sy = this.camera.worldToScreenY(creep.y);
      creep.draw(ctx, sx, sy);
    }
  }

  /**
   * Mirrors UIManager.update()'s stats-panel logic (HP/KDA/timer, the
   * recall status readout, and Benedetta's energy bar + Charge/DASH
   * attack button) using the guest's own puppet as the data source,
   * since this view has no real local Player to hand to UIManager.
   */
  _updateStatsPanel(deltaTime) {
    this._fpsFrames++;
    this._fpsTimer += deltaTime;
    if (this._fpsTimer >= 500) {
      if (this.fpsElement) this.fpsElement.textContent = Math.round((this._fpsFrames * 1000) / this._fpsTimer);
      this._fpsFrames = 0;
      this._fpsTimer = 0;
    }

    if (this.timeElement) {
      const totalSeconds = Math.floor(this.gameTime / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      this.timeElement.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
    if (this.hpElement) this.hpElement.textContent = Math.round(this.guestPuppet.hp);
    if (this.maxHpElement) this.maxHpElement.textContent = this.guestPuppet.maxHp;
    if (this.kdaElement) {
      this.kdaElement.textContent = `${this.guestKda.kills}/${this.guestKda.deaths}/${this.guestKda.assists}`;
    }
    if (this.scoreboardPlayerKillsElement) this.scoreboardPlayerKillsElement.textContent = this.guestKda.kills;
    if (this.scoreboardEnemyKillsElement) this.scoreboardEnemyKillsElement.textContent = this.hostKda.kills;

    if (this.recallStatusElement) {
      if (this.guestPuppet.isRecalling) {
        this.recallStatusElement.textContent = `${Math.ceil((this.guestPuppet.recallTimer || 0) / 1000)}s`;
        this.recallStatusElement.style.color = '#81d4fa';
      } else {
        this.recallStatusElement.textContent = 'Ready';
        this.recallStatusElement.style.color = '#7ee0ff';
      }
    }

    const isBenedetta = this.guestPuppet.character === 'benedetta';
    const isMobileMode = document.body.classList.contains('mobile-mode');
    if (this.attackButton) {
      this.attackButton.style.display = (isBenedetta || isMobileMode) ? 'block' : 'none';
      if (isBenedetta) {
        this.attackButton.textContent = (this.guestPuppet.energy || 0) >= (this.guestPuppet.maxEnergy || 90) ? 'DASH!' : 'CHARGE';
        this.attackButton.classList.toggle('charging', !!this.guestPuppet.isChargingPassive);
      } else {
        this.attackButton.textContent = 'ATTACK';
        this.attackButton.classList.remove('charging');
      }
    }
    if (this.energyBar) {
      this.energyBar.style.display = isBenedetta ? 'block' : 'none';
      if (isBenedetta && this.energyBarFill) {
        this.energyBarFill.style.width = `${((this.guestPuppet.energy || 0) / (this.guestPuppet.maxEnergy || 90)) * 100}%`;
      }
    }

    // Skill bar - reuses UIManager's own DOM refs + per-slot renderer so
    // the cooldown drain/recast-glow look pixel-identical to the host's.
    // guestSkillManager's cooldownRemaining/phase/etc. are kept in sync
    // by applySyncState() in _applyState(), same broadcast tick as HP/position.
    for (let i = 0; i < this.ui.skillSlotRefs.length; i++) {
      this.ui._updateSkillSlot(this.guestSkillManager.skills[i], this.ui.skillSlotRefs[i]);
    }
  }
}
