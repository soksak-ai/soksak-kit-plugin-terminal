import type { ProviderTerminalPluginHost } from "./provider-terminal-plugin";

/** Telling the core which session a view holds.
 *
 *  The core keeps an index — which sessions exist, which component owns each, and where each was
 *  last shown (SESSION.md S1-2). Nothing else can build it: the owner issues the id and the view
 *  knows the coordinate, and only the moment they meet has both.
 *
 *  Without this the index is empty in a running application. The session listing then answers
 *  nothing, a detached session cannot be found by anything, and the lost count is zero because
 *  there is nothing to count.
 *
 *  The id travels as text. A session id is the owner's to shape and this kit reads nothing out of
 *  it; sending it as a number puts it through a JSON parser that is exact only to 2^53. */

export interface CoreIndex {
  /** Records that this view holds this session. Repeating it moves the coordinate. */
  attach(session: number, viewId: string): void;
  /** Takes the coordinate off a session that is still running. The session stays in the index. */
  detach(session: number): void;
}

/** The index writer for one plugin, or one that does nothing when the host serves no index.
 *
 *  A failure is reported and swallowed: the session is running either way, and a terminal that
 *  refused to draw because the core could not write a note about it would trade the work for the
 *  note.
 */
export function coreIndex(host: ProviderTerminalPluginHost, owner: string): CoreIndex {
  const execute = host.commands?.execute;
  if (!execute || !owner) {
    return { attach: () => {}, detach: () => {} };
  }
  const report = (what: string, error: unknown) => {
    console.error(`terminal: the core index did not record ${what}`, error);
  };
  return {
    attach(session, viewId) {
      void Promise.resolve(
        execute("session_attach", { session: String(session), owner, viewId }),
      ).catch((error) => report(`session ${session} on view ${viewId}`, error));
    },
    detach(session) {
      void Promise.resolve(execute("session_detach", { session: String(session) })).catch(
        (error) => report(`the detach of session ${session}`, error),
      );
    },
  };
}
