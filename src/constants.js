'use strict';
// Branding and shared constants. Rename the plugin here (and in manifest.json).
module.exports = {
  PLUGIN_NAME: 'Wheelhouse Task View',
  VIEW_TYPE: 'task-overview-dashboard',
  RIBBON_ICON: 'list-checks',
  LANES: ['now', 'later', 'someday'],
  LANE_LABELS: { now: 'Now', later: 'Later', someday: 'Someday', unassigned: 'Unassigned' }, // default titles; the user can rename them
  LANE_COLORS: { now: '#F2994A', later: '#4C8DF6', someday: '#9B7BF2', unassigned: '#36A89A' },
  TITLE_MAX: 40,
  STALE_MS: 30 * 24 * 60 * 60 * 1000, // how long vanished tasks keep their metadata
  FRESH_MS: 120 * 1000, // window in which a new task may adopt metadata of a moved one
};
