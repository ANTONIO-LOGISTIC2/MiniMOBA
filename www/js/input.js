/**
 * input.js
 * ------------------------------------------------------
 * Handles all keyboard input for the game.
 * Keeps a simple map of which keys are currently held down
 * so other modules (like Player) can check input state
 * on every frame instead of relying on individual key events.
 * ------------------------------------------------------
 */

class InputHandler {
  constructor() {
    // Stores the "pressed" state of every key we care about.
    this.keys = {
      w: false,
      a: false,
      s: false,
      d: false
    };

    // One-shot click buffer: set by a canvas click, read (and
    // cleared) once per frame by game.js to trigger an attack.
    // Storing SCREEN-space coordinates here; game.js converts to
    // world-space using the camera before using them.
    this._pendingClick = null;

    // Space bar attack buffer - one-shot per keypress
    this._pendingSpaceAttack = false;
    this._attackHeld = false;
    this._attackPressed = false;
    this._attackReleased = false;

    // Skill-slot buffers (keys 1/2/3) - one-shot per keypress, one per slot
    this._pendingSkillCasts = { 1: false, 2: false, 3: false };

    // Recall (B key) buffer - one-shot per keypress
    this._pendingRecall = false;

    // Camera panning uses the same canvas as click-to-attack. Pointer
    // movement is accumulated here and consumed by Game only while the
    // player is dead; a genuine drag suppresses its trailing click.
    this._isMapDragging = false;
    this._mapDragX = 0;
    this._mapDragY = 0;
    this._lastPointerX = 0;
    this._lastPointerY = 0;
    this._mapDragDistance = 0;
    this._didDragMap = false;

    // Virtual joystick state (mobile/touch layout only). While active,
    // this vector takes priority over WASD in getMovementVector().
    this._joystickActive = false;
    this._joystickVector = { x: 0, y: 0 };
    this._joystickPointerId = null;

    // Bind listeners once, on construction.
    this._registerListeners();

    // Detect touch/mobile layout (real phones AND Chrome DevTools'
    // device toolbar, Ctrl+Shift+M, which sets pointer:coarse + a
    // narrow viewport) and toggle the CSS layout for it. Re-checked
    // on resize since toggling the device toolbar fires one.
    this._detectMobileMode();
    window.addEventListener('resize', () => this._detectMobileMode());
  }

  /**
   * Attaches keydown/keyup listeners to the window.
   * Uses event.key.toLowerCase() so both upper/lowercase
   * and different keyboard layouts still work for WASD.
   */
  _registerListeners() {
    window.addEventListener('keydown', (e) => {
      const key = e.key.toLowerCase();
      if (key in this.keys) {
        this.keys[key] = true;
      }
      // Space bar for basic attack
      if (key === ' ') {
        this._pendingSpaceAttack = true;
        if (!this._attackHeld) this._attackPressed = true;
        this._attackHeld = true;
      }
      // 1/2/3 for the three skill slots
      if (key === '1' || key === '2' || key === '3') {
        // Ignore the browser's auto-repeat while a key is held. A skill
        // should cast once per distinct press, matching a mobile button tap.
        if (e.repeat) return;
        this._pendingSkillCasts[key] = true;
      }
      // B key for recall
      if (key === 'b') {
        this._pendingRecall = true;
      }
    });

    window.addEventListener('keyup', (e) => {
      const key = e.key.toLowerCase();
      if (key in this.keys) {
        this.keys[key] = false;
      }
      if (key === ' ') {
        if (this._attackHeld) this._attackReleased = true;
        this._attackHeld = false;
      }
    });

    // Safety net: if the browser window loses focus (alt-tab, etc.)
    // release all keys so the player doesn't get "stuck" moving.
    window.addEventListener('blur', () => {
      for (const key in this.keys) {
        this.keys[key] = false;
      }
      this._pendingSpaceAttack = false;
      this._attackHeld = false;
      this._attackPressed = false;
      this._attackReleased = false;
      this._pendingSkillCasts = { 1: false, 2: false, 3: false };
      this._pendingRecall = false;
      this._isMapDragging = false;
      this._mapDragX = 0;
      this._mapDragY = 0;
      this._mapDragDistance = 0;
      this._didDragMap = false;
      this._joystickActive = false;
      this._joystickPointerId = null;
      this._joystickVector = { x: 0, y: 0 };
      const knob = document.getElementById('joystick-knob');
      if (knob) knob.style.transform = 'translate(0, 0)';
    });

    // Left-click on the canvas = attack command. We store the
    // click position (relative to the canvas) and let game.js
    // decide what, if anything, was clicked on.
    const canvas = document.getElementById('gameCanvas');
    if (canvas) {
      canvas.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        this._isMapDragging = true;
        this._didDragMap = false;
        this._mapDragDistance = 0;
        this._lastPointerX = e.clientX;
        this._lastPointerY = e.clientY;
        canvas.setPointerCapture?.(e.pointerId);
      });

      canvas.addEventListener('pointermove', (e) => {
        if (!this._isMapDragging) return;
        const dx = e.clientX - this._lastPointerX;
        const dy = e.clientY - this._lastPointerY;
        this._lastPointerX = e.clientX;
        this._lastPointerY = e.clientY;
        this._mapDragX += dx;
        this._mapDragY += dy;
        this._mapDragDistance += Math.abs(dx) + Math.abs(dy);
        if (this._mapDragDistance > 3) this._didDragMap = true;
      });

      const stopMapDrag = (e) => {
        if (e.type === 'pointerup' && e.button !== 0) return;
        this._isMapDragging = false;
        canvas.releasePointerCapture?.(e.pointerId);
      };
      canvas.addEventListener('pointerup', stopMapDrag);
      canvas.addEventListener('pointercancel', stopMapDrag);

      canvas.addEventListener('click', (e) => {
        if (this._didDragMap) {
          this._didDragMap = false;
          return;
        }
        const rect = canvas.getBoundingClientRect();
        this._pendingClick = {
          x: e.clientX - rect.left,
          y: e.clientY - rect.top
        };
      });
    }

    const attackButton = document.getElementById('attack-button');
    if (attackButton) {
      attackButton.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (!this._attackHeld) this._attackPressed = true;
        this._attackHeld = true;
        attackButton.setPointerCapture?.(e.pointerId);
      });
      const releaseAttack = (e) => {
        e.preventDefault();
        if (this._attackHeld) this._attackReleased = true;
        this._attackHeld = false;
      };
      attackButton.addEventListener('pointerup', releaseAttack);
      attackButton.addEventListener('pointercancel', releaseAttack);
    }

    // Mobile recall button - same effect as pressing B on desktop.
    const recallButton = document.getElementById('recall-button-mobile');
    if (recallButton) {
      recallButton.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._pendingRecall = true;
      });
    }

    // Tapping a skill icon directly casts that skill - the 1/2/3 keys
    // don't exist on a touchscreen, so the mobile layout relies on this.
    for (const slot of [1, 2, 3]) {
      const slotElement = document.getElementById(`skill-slot-${slot}`);
      if (!slotElement) continue;
      slotElement.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._pendingSkillCasts[slot] = true;
      });
    }

    // Virtual joystick (mobile layout only, but harmless to wire up
    // unconditionally - it's simply hidden/unreachable on desktop).
    const joystickBase = document.getElementById('joystick-base');
    const joystickKnob = document.getElementById('joystick-knob');
    if (joystickBase && joystickKnob) {
      const maxRadius = 40; // px the knob can travel from center

      const updateJoystick = (clientX, clientY) => {
        const rect = joystickBase.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;

        let dx = clientX - centerX;
        let dy = clientY - centerY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist > maxRadius) {
          dx = (dx / dist) * maxRadius;
          dy = (dy / dist) * maxRadius;
        }

        joystickKnob.style.transform = `translate(${dx}px, ${dy}px)`;

        // Normalized direction vector, matching the shape
        // getMovementVector() already returns for WASD.
        if (dist > 6) {
          this._joystickVector = { x: dx / maxRadius, y: dy / maxRadius };
        } else {
          this._joystickVector = { x: 0, y: 0 };
        }
      };

      const resetJoystick = () => {
        this._joystickActive = false;
        this._joystickPointerId = null;
        this._joystickVector = { x: 0, y: 0 };
        joystickKnob.style.transform = 'translate(0, 0)';
      };

      joystickBase.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._joystickActive = true;
        this._joystickPointerId = e.pointerId;
        joystickBase.setPointerCapture?.(e.pointerId);
        updateJoystick(e.clientX, e.clientY);
      });

      joystickBase.addEventListener('pointermove', (e) => {
        if (!this._joystickActive || e.pointerId !== this._joystickPointerId) return;
        e.preventDefault();
        updateJoystick(e.clientX, e.clientY);
      });

      const stopJoystick = (e) => {
        if (e.pointerId !== this._joystickPointerId) return;
        joystickBase.releasePointerCapture?.(e.pointerId);
        resetJoystick();
      };
      joystickBase.addEventListener('pointerup', stopJoystick);
      joystickBase.addEventListener('pointercancel', stopJoystick);
    }
  }

  /**
   * Switches the whole UI into the touch-friendly Android-style layout
   * (joystick + arc of skill buttons around a big attack button)
   * whenever the browser reports a coarse pointer (a real touchscreen,
   * or Chrome DevTools' device toolbar / Ctrl+Shift+M) alongside a
   * phone-ish viewport width. Desktop mouse users keep the original
   * keyboard-oriented HUD untouched.
   */
  _detectMobileMode() {
    const hasTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    const isCoarsePointer = window.matchMedia('(pointer: coarse)').matches;
    const isNarrow = window.innerWidth <= 1080;
    document.body.classList.toggle('mobile-mode', (hasTouch || isCoarsePointer) && isNarrow);
  }

  /**
   * Returns the most recent unread click position (screen-space,
   * relative to the canvas) and clears it, so each click is only
   * ever consumed once. Returns null if there's no new click.
   */
  consumeClick() {
    const click = this._pendingClick;
    this._pendingClick = null;
    return click;
  }

  /**
   * Returns the unread mouse-drag movement and clears it. Game decides
   * whether panning is currently allowed (only while the player is dead).
   */
  consumeMapDrag() {
    const drag = { x: this._mapDragX, y: this._mapDragY };
    this._mapDragX = 0;
    this._mapDragY = 0;
    return drag;
  }

  /**
   * Returns true if space bar was pressed this frame, and clears it.
   * Used for basic attack command.
   */
  consumeSpaceAttack() {
    const attack = this._pendingSpaceAttack;
    this._pendingSpaceAttack = false;
    return attack;
  }

  consumeAttackPressed() { const pressed = this._attackPressed; this._attackPressed = false; return pressed; }
  consumeAttackReleased() { const released = this._attackReleased; this._attackReleased = false; return released; }
  get isAttackHeld() { return this._attackHeld; }

  /**
   * Returns true if the given skill-slot key (1, 2, or 3) was
   * pressed this frame, and clears it. Used to trigger the
   * matching skill in SkillManager.
   * @param {number} slotNumber - 1, 2, or 3
   */
  consumeSkillCast(slotNumber) {
    const key = String(slotNumber);
    const cast = this._pendingSkillCasts[key];
    this._pendingSkillCasts[key] = false;
    return cast;
  }

  /**
   * Returns true if the B key was pressed this frame, and clears it.
   * Used to trigger recall.
   */
  consumeRecall() {
    const recall = this._pendingRecall;
    this._pendingRecall = false;
    return recall;
  }

  /**
   * Returns true if the given key is currently held down.
   * @param {string} key - single lowercase letter, e.g. 'w'
   */
  isDown(key) {
    return !!this.keys[key];
  }

  /**
   * Convenience method: returns a normalized movement vector
   * { x, y } based on WASD state. Values are -1, 0, or 1
   * before normalization; diagonal movement is normalized
   * so diagonal speed isn't faster than straight movement.
   */
  getMovementVector() {
    // The joystick, while actively being dragged, takes priority over
    // the keyboard - it already comes pre-normalized to a unit circle.
    if (this._joystickActive && (this._joystickVector.x !== 0 || this._joystickVector.y !== 0)) {
      return { x: this._joystickVector.x, y: this._joystickVector.y };
    }

    let x = 0;
    let y = 0;

    if (this.keys.a) x -= 1;
    if (this.keys.d) x += 1;
    if (this.keys.w) y -= 1;
    if (this.keys.s) y += 1;

    // Normalize diagonal vectors so moving diagonally isn't
    // faster than moving in a single direction (Pythagoras).
    if (x !== 0 && y !== 0) {
      const length = Math.sqrt(x * x + y * y);
      x /= length;
      y /= length;
    }

    return { x, y };
  }
}

// Single shared instance used across the whole game.
const inputHandler = new InputHandler();
