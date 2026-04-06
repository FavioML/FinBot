/**
 * Seeded sampler for NLP test pool.
 * Given a seed (git commit hash), selects N cases from the pool
 * with varying category weights per run.
 */

// Mulberry32 — fast seeded 32-bit PRNG
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Convert hex string (git hash) to a 32-bit integer seed
function hashToSeed(hex) {
  let h = 0;
  for (let i = 0; i < hex.length; i++) {
    h = (Math.imul(31, h) + hex.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

// Fisher-Yates shuffle with seeded PRNG
function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Sample N cases from pool with varying category weights.
 *
 * Each category has a min/max range. The seed determines
 * how many cases are picked from each category (within range).
 * The totals are then normalized to exactly N.
 *
 * @param {Array} pool — full pool of test cases
 * @param {string} seed — git commit hash or any string
 * @param {number} n — number of cases to select (default 300)
 * @returns {{ cases: Array, meta: Object }}
 */
function sample(pool, seed, n = 300) {
  const rng = mulberry32(hashToSeed(seed));

  // Group pool by category
  const byCategory = {};
  for (const c of pool) {
    if (!byCategory[c.cat]) byCategory[c.cat] = [];
    byCategory[c.cat].push(c);
  }

  const categories = Object.keys(byCategory);

  // Each category gets a random weight between 0.3 and 1.0
  const weights = {};
  let totalWeight = 0;
  for (const cat of categories) {
    weights[cat] = 0.3 + rng() * 0.7;
    totalWeight += weights[cat];
  }

  // Distribute N across categories proportionally to weights,
  // but clamped: at least 2 per category, at most pool size
  const allotments = {};
  let allocated = 0;
  for (const cat of categories) {
    const ideal = Math.round((weights[cat] / totalWeight) * n);
    const clamped = Math.max(2, Math.min(ideal, byCategory[cat].length));
    allotments[cat] = clamped;
    allocated += clamped;
  }

  // Adjust to exactly N
  while (allocated !== n) {
    const cat = categories[Math.floor(rng() * categories.length)];
    if (allocated < n && allotments[cat] < byCategory[cat].length) {
      allotments[cat]++;
      allocated++;
    } else if (allocated > n && allotments[cat] > 2) {
      allotments[cat]--;
      allocated--;
    }
  }

  // Pick cases from each category (shuffled)
  const selected = [];
  const distribution = {};
  for (const cat of categories) {
    const shuffled = shuffle(byCategory[cat], rng);
    const picked = shuffled.slice(0, allotments[cat]);
    selected.push(...picked);
    distribution[cat] = picked.length;
  }

  // Final shuffle so categories are interleaved
  const result = shuffle(selected, rng);

  return {
    cases: result,
    meta: {
      seed,
      total: result.length,
      poolSize: pool.length,
      distribution,
    },
  };
}

module.exports = { sample, hashToSeed, mulberry32 };
