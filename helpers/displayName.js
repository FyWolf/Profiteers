// Canonical display-name resolver: guild nickname → Discord global name →
// account username. Use everywhere a person is shown. Accepts any object that
// carries some of these fields (raw user rows, roster rows, or joined results).
//
// Field precedence:
//   roster_nickname / nickname  — the per-guild server nickname (roster_members.nickname)
//   discord_global_name         — Discord global display name
//   username                    — local account username
//   discord_username            — Discord @handle (last resort)
module.exports = function displayName(o, fallback = 'Unknown') {
    if (!o) return fallback;
    return o.roster_nickname
        || o.nickname
        || o.discord_global_name
        || o.username
        || o.discord_username
        || fallback;
};
