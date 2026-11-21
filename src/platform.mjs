// Which platform the measurement code behaves as.
//
// The deduplicated metric (issue #10) needs /proc/<pid>/smaps, so it exists on
// Linux only; everywhere else the sampler falls back to `ps` and the checks are
// report-only. PMB_PLATFORM overrides the detection so the non-Linux behaviour
// can be exercised on a Linux CI runner (and on a developer machine) without a
// Mac: it is a test seam, not a user option, and nothing else reads it.

/**
 * @returns {string} process.platform value, or the PMB_PLATFORM override
 */
export function measurePlatform() {
  const forced = process.env.PMB_PLATFORM?.trim();
  return forced ? forced : process.platform;
}

/**
 * Whether shared file-backed pages can be identified here, i.e. whether the
 * deduplicated metric is available.
 * @returns {boolean}
 */
export function hasSmaps() {
  return measurePlatform() === "linux";
}
