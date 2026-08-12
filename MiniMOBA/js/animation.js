/**
 * animation.js
 * ------------------------------------------------------
 * Generic sprite-sheet animator.
 *
 * Expects a sprite sheet laid out as a grid:
 *   - Each ROW = one animation direction/state (down, left, right, up)
 *   - Each COLUMN = one frame of that animation
 *
 * This class is reused by both Player and Enemy so animation
 * logic is never duplicated.
 * ------------------------------------------------------
 */

class SpriteAnimator {
  /**
   * @param {HTMLImageElement} image - the loaded sprite sheet image
   * @param {number} frameWidth - width of a single frame in pixels
   * @param {number} frameHeight - height of a single frame in pixels
   * @param {Object} rowMap - maps animation names to row index, e.g.
   *        { down: 0, left: 1, right: 2, up: 3 }
   * @param {number} frameCount - number of columns (frames) per row
   * @param {number} frameDuration - ms each frame is shown before advancing
   */
  constructor(image, frameWidth, frameHeight, rowMap, frameCount, frameDuration = 120) {
    this.image = image;
    this.frameWidth = frameWidth;
    this.frameHeight = frameHeight;
    this.rowMap = rowMap;
    this.frameCount = frameCount;
    this.frameDuration = frameDuration;

    this.currentAnimation = 'down'; // default facing direction
    this.currentFrame = 0;
    this.elapsedTime = 0;
    this.isMoving = false; // when false, animation freezes on idle frame
  }

  /**
   * Call this every frame with the delta time and current state.
   * @param {number} deltaTime - ms since last frame
   * @param {string} direction - 'down' | 'left' | 'right' | 'up'
   * @param {boolean} isMoving - whether the entity is currently walking
   */
  update(deltaTime, direction, isMoving) {
    // If direction changed, reset the frame so animations don't look glitchy.
    if (direction !== this.currentAnimation) {
      this.currentAnimation = direction;
      this.currentFrame = 0;
      this.elapsedTime = 0;
    }

    this.isMoving = isMoving;

    if (!isMoving) {
      // Idle: freeze on the first frame of the current direction row.
      this.currentFrame = 0;
      this.elapsedTime = 0;
      return;
    }

    // Advance the animation timer and move to next frame when needed.
    this.elapsedTime += deltaTime;
    if (this.elapsedTime >= this.frameDuration) {
      this.elapsedTime = 0;
      this.currentFrame = (this.currentFrame + 1) % this.frameCount;
    }
  }

  /**
   * Draws the current animation frame to the canvas at (x, y),
   * centered horizontally on x and with feet anchored near y.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x - world/screen x (center of sprite)
   * @param {number} y - world/screen y (center of sprite)
   * @param {number} drawWidth - output width on screen
   * @param {number} drawHeight - output height on screen
   */
  draw(ctx, x, y, drawWidth, drawHeight) {
    const row = this.rowMap[this.currentAnimation] ?? 0;
    const sx = this.currentFrame * this.frameWidth;
    const sy = row * this.frameHeight;

    ctx.drawImage(
      this.image,
      sx, sy, this.frameWidth, this.frameHeight,      // source rect
      x - drawWidth / 2, y - drawHeight / 2,            // destination position
      drawWidth, drawHeight                             // destination size
    );
  }
}
