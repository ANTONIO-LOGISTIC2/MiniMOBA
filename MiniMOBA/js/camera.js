/**
 * camera.js
 * ------------------------------------------------------
 * A simple 2D camera that follows a target (the player)
 * with smooth interpolation (lerp) instead of snapping
 * instantly, which gives a much more polished feel.
 *
 * The camera exposes worldToScreen helpers so game.js can
 * convert world-space coordinates into screen-space
 * coordinates for drawing.
 * ------------------------------------------------------
 */

class Camera {
  /**
   * @param {number} viewWidth - width of the visible canvas area
   * @param {number} viewHeight - height of the visible canvas area
   * @param {Object} mapBounds - { minX, minY, maxX, maxY } world limits
   */
  constructor(viewWidth, viewHeight, mapBounds) {
    this.viewWidth = viewWidth;
    this.viewHeight = viewHeight;
    this.mapBounds = mapBounds;

    // x, y = world-space coordinates of the camera's top-left corner.
    this.x = 0;
    this.y = 0;

    // Smoothing factor: lower = smoother/slower, higher = snappier.
    this.smoothing = 0.1;
  }

  /**
   * Updates the camera's viewport size (e.g. on window resize).
   */
  resize(viewWidth, viewHeight) {
    this.viewWidth = viewWidth;
    this.viewHeight = viewHeight;
  }

  /**
   * Moves the camera smoothly toward centering on the target.
   * @param {{x: number, y: number}} target - world-space point to follow (usually player center)
   */
  follow(target) {
    // Where the camera SHOULD be to perfectly center the target.
    const desiredX = target.x - this.viewWidth / 2;
    const desiredY = target.y - this.viewHeight / 2;

    // Smoothly interpolate current position toward the desired position.
    this.x += (desiredX - this.x) * this.smoothing;
    this.y += (desiredY - this.y) * this.smoothing;

    // Keep the camera from showing area outside the map.
    this._clampToMap();
  }

  /**
   * Moves the viewport by a screen-space drag delta while free-camera
   * mode is active (currently used only during the player's respawn).
   */
  panBy(deltaX, deltaY) {
    this.x += deltaX;
    this.y += deltaY;
    this._clampToMap();
  }

  /**
   * Prevents the camera from scrolling past the edges of the map,
   * so the player never sees black/empty space beyond the world.
   */
  _clampToMap() {
    const maxCamX = Math.max(this.mapBounds.minX, this.mapBounds.maxX - this.viewWidth);
    const maxCamY = Math.max(this.mapBounds.minY, this.mapBounds.maxY - this.viewHeight);

    this.x = Math.min(Math.max(this.x, this.mapBounds.minX), maxCamX);
    this.y = Math.min(Math.max(this.y, this.mapBounds.minY), maxCamY);
  }

  /**
   * Converts a world-space X coordinate into screen-space.
   */
  worldToScreenX(worldX) {
    return worldX - this.x;
  }

  /**
   * Converts a world-space Y coordinate into screen-space.
   */
  worldToScreenY(worldY) {
    return worldY - this.y;
  }
}
