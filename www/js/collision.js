/**
 * collision.js
 * ------------------------------------------------------
 * Basic collision & boundary helpers.
 *
 * Phase 1 only needs map-boundary clamping (the player cannot
 * leave the map), but this file is structured so that
 * rectangle/circle collision checks can be added later for
 * Phase 2 (obstacles, other units, projectiles, etc.)
 * without touching player.js.
 * ------------------------------------------------------
 */

const Collision = {
  /**
   * Clamps a position so an entity (treated as a box) stays
   * fully inside the map boundaries.
   *
   * @param {number} x - proposed center x
   * @param {number} y - proposed center y
   * @param {number} halfWidth - half the entity's collision width
   * @param {number} halfHeight - half the entity's collision height
   * @param {Object} mapBounds - { minX, minY, maxX, maxY }
   * @returns {{x: number, y: number}} clamped position
   */
  clampToMap(x, y, halfWidth, halfHeight, mapBounds) {
    const clampedX = Math.min(
      Math.max(x, mapBounds.minX + halfWidth),
      mapBounds.maxX - halfWidth
    );
    const clampedY = Math.min(
      Math.max(y, mapBounds.minY + halfHeight),
      mapBounds.maxY - halfHeight
    );
    return { x: clampedX, y: clampedY };
  },

  /**
   * Simple Axis-Aligned Bounding Box (AABB) intersection test.
   * Reserved for future use (Phase 2+: obstacles, hitboxes, etc.)
   * @param {Object} a - { x, y, width, height } (x,y = top-left)
   * @param {Object} b - { x, y, width, height }
   */
  rectsIntersect(a, b) {
    return (
      a.x < b.x + b.width &&
      a.x + a.width > b.x &&
      a.y < b.y + b.height &&
      a.y + a.height > b.y
    );
  },

  /**
   * Simple circle-circle collision test.
   * Reserved for future use (Phase 2+: units, projectiles).
   * @param {number} x1 @param {number} y1 @param {number} r1
   * @param {number} x2 @param {number} y2 @param {number} r2
   */
  circlesIntersect(x1, y1, r1, x2, y2, r2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const distance = Math.sqrt(dx * dx + dy * dy);
    return distance < r1 + r2;
  }
};
