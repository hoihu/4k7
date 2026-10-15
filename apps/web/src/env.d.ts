/** Built as the packaged app (served by the local server), not the dev server of a checkout. */
declare const __PACKAGED__: boolean;
/** Runs the server for the app's chat ("npm run server" in a checkout, npx for the package). */
declare const __SERVER_RUN__: string;
/** The downloaded app (__SERVER_RUN__ names it; it opens the link itself) rather than a command that prints it. */
declare const __APP_RUN__: boolean;
/** What Claude Code starts as the 4k7 MCP server. */
declare const __SERVER_MCP__: string;
declare const __BUILD_ID__: string;
/** Text files imported as they are (the agent's guides). */
declare module '*.md?raw' {
  const text: string;
  export default text;
}
