const { getUserPlanConfig } = require('./db-helpers');

/**
 * Check if a feature is available for the user's plan.
 * @param {object} usuario - User object with plan field
 * @param {string} feature - Feature key from PLAN_CONFIG
 * @returns {{ blocked: boolean, value: any }}
 */
function checkProWall(usuario, feature) {
  const config = getUserPlanConfig(usuario);
  const value = config[feature];
  if (value === false || value === 0) return { blocked: true, value };
  return { blocked: false, value };
}

/**
 * Check a numeric limit (e.g. maxMetas, maxSpaces).
 * @param {object} usuario
 * @param {string} feature - Feature key in PLAN_CONFIG
 * @param {number} currentCount - Current count of items
 * @returns {{ blocked: boolean, limit: number }}
 */
function checkProLimit(usuario, feature, currentCount) {
  const config = getUserPlanConfig(usuario);
  const limit = config[feature];
  if (limit === Infinity || limit === null) return { blocked: false, limit };
  if (currentCount >= limit) return { blocked: true, limit };
  return { blocked: false, limit };
}

module.exports = { checkProWall, checkProLimit };
