// Runtime mode flag, read by app.js before it builds a socket.
// Default (this file, shipped with the self-hosted build) is the WebSocket server.
// The GitHub Pages workflow overwrites this file with `window.HOUSIE_STATIC = true`.
window.HOUSIE_STATIC = false;
