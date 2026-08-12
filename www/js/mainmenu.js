/**
 * mainmenu.js
 * ------------------------------------------------------
 * Drives the whole pre-game flow, across 3 screens:
 *
 *   #mode-select  -->  "AI Mode" or "PVP Mode"
 *        |                        |
 *        |                 #pvp-connect (server address,
 *        |                  Host Match / Join Match)
 *        |                        |
 *        v                        v
 *              #main-menu (character select)
 *                        |
 *                        v
 *              new Game(...)  or  new PvpGuestView(...)
 *
 * AI mode behaves exactly as before: pick a hero, hit START, play
 * against the bot. PVP mode adds a detour through #pvp-connect to
 * either host a match (get a room code, wait for someone to join)
 * or join one (type in a room code someone else generated), before
 * landing on the same character-select screen.
 * ------------------------------------------------------
 */

class MainMenu {
  constructor() {
    // Screens
    this.modeSelectScreen = document.getElementById('mode-select');
    this.pvpConnectScreen = document.getElementById('pvp-connect');
    this.mainMenuScreen = document.getElementById('main-menu');
    this.gameContainer = document.getElementById('game-container');

    // Mode-select
    this.modeAiButton = document.getElementById('mode-ai-button');
    this.modePvpButton = document.getElementById('mode-pvp-button');

    // PVP connect
    this.serverUrlInput = document.getElementById('pvp-server-url');
    this.hostJoinRow = document.getElementById('pvp-host-join-row');
    this.hostButton = document.getElementById('pvp-host-button');
    this.joinButton = document.getElementById('pvp-join-button');
    this.joinRow = document.getElementById('pvp-join-row');
    this.roomCodeInput = document.getElementById('pvp-room-code');
    this.joinConfirmButton = document.getElementById('pvp-join-confirm-button');
    this.pvpStatus = document.getElementById('pvp-status');
    this.pvpBackButton = document.getElementById('pvp-back-button');

    // Character select (shared by AI mode and PVP mode)
    this.characterCards = document.querySelectorAll('.character-card');
    this.startButton = document.getElementById('start-button');
    this.pvpWaitStatus = document.getElementById('pvp-wait-status');
    this.mainMenuBackButton = document.getElementById('main-menu-back-button');
    this.controlsHint = document.querySelector('#main-menu .menu-controls-hint');

    this.selectedCharacter = 'gusion';
    this.selectedSprite = 'assets/player/gusion.png';

    // 'ai' | 'pvp-host' | 'pvp-guest'
    this.mode = 'ai';
    this.networkClient = null;
    this.pendingGuestCharacter = null; // set once the guest sends their pick (host only)

    this._init();
  }

  _init() {
    this.modeAiButton.addEventListener('click', () => this._chooseAiMode());
    this.modePvpButton.addEventListener('click', () => this._showPvpConnect());

    this.hostButton.addEventListener('click', () => this._hostMatch());
    this.joinButton.addEventListener('click', () => {
      this.joinRow.classList.remove('hidden');
      this.roomCodeInput.focus();
    });
    this.joinConfirmButton.addEventListener('click', () => this._joinMatch());
    this.roomCodeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._joinMatch();
    });
    this.pvpBackButton.addEventListener('click', () => this._backToModeSelect());

    this.characterCards.forEach((card) => {
      card.addEventListener('click', () => this._selectCharacter(card));
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this._selectCharacter(card);
        }
      });
    });

    this.startButton.addEventListener('click', () => this._handleStart());
    this.mainMenuBackButton.addEventListener('click', () => this._backFromCharacterSelect());
  }

  // ---------------------------------------------------------------
  // Screen transitions
  // ---------------------------------------------------------------

  _chooseAiMode() {
    this.mode = 'ai';
    this.networkClient = null;
    this.modeSelectScreen.classList.add('hidden');
    this._showCharacterSelect();
  }

  _showPvpConnect() {
    this.modeSelectScreen.classList.add('hidden');
    this.pvpConnectScreen.classList.remove('hidden');
    this._setPvpStatus('');
  }

  _backToModeSelect() {
    if (this.networkClient) {
      this.networkClient.disconnect();
      this.networkClient = null;
    }
    this.joinRow.classList.add('hidden');
    this.pvpConnectScreen.classList.add('hidden');
    this.modeSelectScreen.classList.remove('hidden');
  }

  _backFromCharacterSelect() {
    if (this.networkClient) {
      this.networkClient.disconnect();
      this.networkClient = null;
    }
    this.mainMenuScreen.classList.add('hidden');
    this.modeSelectScreen.classList.remove('hidden');
  }

  _showCharacterSelect() {
    this.pvpConnectScreen.classList.add('hidden');
    this.mainMenuScreen.classList.remove('hidden');

    if (this.mode === 'pvp-host') {
      // Can't start until the guest has connected AND picked a hero.
      this.startButton.disabled = true;
      this.pvpWaitStatus.textContent = `Room code: ${this.networkClient.roomCode} - waiting for opponent...`;
      this.pvpWaitStatus.classList.remove('hidden');
      this.controlsHint.classList.add('hidden');
    } else if (this.mode === 'pvp-guest') {
      this.startButton.textContent = 'START';
      this.pvpWaitStatus.classList.add('hidden');
      this.controlsHint.classList.add('hidden');
    } else {
      // AI mode - exactly the original behavior.
      this.startButton.disabled = false;
      this.startButton.textContent = 'START';
      this.pvpWaitStatus.classList.add('hidden');
      this.controlsHint.classList.remove('hidden');
    }
  }

  // ---------------------------------------------------------------
  // PVP connect actions
  // ---------------------------------------------------------------

  async _hostMatch() {
    const serverUrl = this.serverUrlInput.value.trim();
    if (!serverUrl) {
      this._setPvpStatus('Enter a server address first.');
      return;
    }

    this._setPvpStatus('Connecting...');
    this._setPvpButtonsDisabled(true);

    try {
      const client = new NetworkClient();
      await client.connect(serverUrl);
      const roomCode = await client.hostMatch();

      this.networkClient = client;
      this.mode = 'pvp-host';

      client.on('peer-joined', () => this._onGuestJoined());
      client.on('guest-ready', (data) => this._onGuestReady(data));
      client.on('disconnected', () => this._onNetworkLost());
      client.on('peer-left', () => this._onGuestLeft());

      this._setPvpStatus(`Room created: ${roomCode}`, true);
      this._showCharacterSelect();
    } catch (err) {
      this._setPvpStatus(err.message || 'Could not host a match.');
    } finally {
      this._setPvpButtonsDisabled(false);
    }
  }

  async _joinMatch() {
    const serverUrl = this.serverUrlInput.value.trim();
    const roomCode = this.roomCodeInput.value.trim().toUpperCase();

    if (!serverUrl) {
      this._setPvpStatus('Enter a server address first.');
      return;
    }
    if (!roomCode) {
      this._setPvpStatus('Enter the room code your opponent gave you.');
      return;
    }

    this._setPvpStatus('Connecting...');
    this._setPvpButtonsDisabled(true);

    try {
      const client = new NetworkClient();
      await client.connect(serverUrl);
      await client.joinMatch(roomCode);

      this.networkClient = client;
      this.mode = 'pvp-guest';

      client.on('disconnected', () => this._onNetworkLost());
      client.on('peer-left', () => this._onGuestLeft());

      this._setPvpStatus('Connected!', true);
      this._showCharacterSelect();
    } catch (err) {
      this._setPvpStatus(err.message || 'Could not join that room.');
    } finally {
      this._setPvpButtonsDisabled(false);
    }
  }

  _onGuestJoined() {
    this.pvpWaitStatus.textContent = `Room code: ${this.networkClient.roomCode} - opponent connected! Waiting for them to pick a hero...`;
  }

  _onGuestReady(data) {
    this.pendingGuestCharacter = data.character;
    this.pvpWaitStatus.textContent = 'Opponent is ready! Pick your hero and hit START.';
    this.startButton.disabled = false;
  }

  _onGuestLeft() {
    if (this.mode === 'pvp-host') {
      this.pendingGuestCharacter = null;
      this.startButton.disabled = true;
      this.pvpWaitStatus.textContent = `Room code: ${this.networkClient.roomCode} - opponent disconnected. Waiting for someone new...`;
      this.pvpWaitStatus.classList.remove('hidden');
    }
  }

  _onNetworkLost() {
    // Only matters pre-game - once the actual match starts, Game/
    // PvpGuestView handle their own disconnect messaging instead.
    if (this.mainMenuScreen.classList.contains('hidden')) return;
    this.pvpWaitStatus.textContent = 'Lost connection to the server.';
    this.pvpWaitStatus.classList.remove('hidden');
    this.startButton.disabled = true;
  }

  _setPvpStatus(text, ok = false) {
    this.pvpStatus.textContent = text;
    this.pvpStatus.classList.toggle('pvp-status-ok', ok);
  }

  _setPvpButtonsDisabled(disabled) {
    this.hostButton.disabled = disabled;
    this.joinButton.disabled = disabled;
    this.joinConfirmButton.disabled = disabled;
  }

  // ---------------------------------------------------------------
  // Character select
  // ---------------------------------------------------------------

  _selectCharacter(card) {
    this.characterCards.forEach((c) => c.classList.remove('selected'));
    card.classList.add('selected');
    this.selectedCharacter = card.dataset.character;
    this.selectedSprite = card.dataset.sprite;
  }

  _handleStart() {
    if (this.mode === 'pvp-guest') {
      // Tell the host which hero we picked, then start rendering
      // immediately - the host will start on its own once it gets this.
      this.networkClient.send('guest-ready', { character: this.selectedCharacter, sprite: this.selectedSprite });
      this._enterGame();
      new PvpGuestView(this.selectedSprite, this.networkClient);
      return;
    }

    this._enterGame();

    if (this.mode === 'pvp-host') {
      new Game(this.selectedSprite, {
        networkClient: this.networkClient,
        guestCharacter: this.pendingGuestCharacter
      });
    } else {
      new Game(this.selectedSprite);
    }
  }

  _enterGame() {
    this.mainMenuScreen.classList.add('hidden');
    this.gameContainer.classList.add('visible');
  }

  /**
   * Called once both sides have agreed to a rematch (see the Rematch
   * button/handshake in game.js and pvp-guest.js). The network
   * connection is deliberately left alive - this just replays the
   * character-select step so both players can pick a hero again,
   * exactly like the very first time, without having to re-host or
   * re-join the room.
   */
  prepareRematch() {
    this.pendingGuestCharacter = null;
    this.gameContainer.classList.remove('visible');
    this.mainMenuScreen.classList.remove('hidden');
    this._showCharacterSelect();
  }
}

// Initialize the main menu when the page loads. Exposed on window so
// Game/PvpGuestView can hand control back to it for a PVP rematch
// without needing to re-host or re-join the room.
window.addEventListener('load', () => {
  window.mainMenu = new MainMenu();
});
