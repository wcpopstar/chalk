// Pure URL builders. No DOM, no globals — safe leaf module.

// Builds the public profile URL for an external gaming platform from a user-
// supplied handle. The handle is always encodeURIComponent'd and the host is a
// fixed per-platform template, so the result can never be an arbitrary link
// (defense in depth — these hrefs render on other users' profiles). Unknown
// platform → null (caller omits the link).
export function gamingLinkUrl(platform, handle) {
  const v = encodeURIComponent(handle);
  switch (platform) {
    case 'steam':    return /^\d{17}$/.test(handle) ? `https://steamcommunity.com/profiles/${v}` : `https://steamcommunity.com/id/${v}`;
    case 'psn':      return `https://psnprofiles.com/${v}`;
    case 'xbox':     return `https://www.xboxgamertag.com/search/${v}`;
    case 'valorant': return `https://tracker.gg/valorant/profile/riot/${v}/overview`;
    case 'faceit':   return `https://www.faceit.com/en/players/${v}`;
    case 'twitch':   return `https://www.twitch.tv/${v}`;
    default:         return null;
  }
}
