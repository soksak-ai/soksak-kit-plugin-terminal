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
  // The host is read at each call, never destructured once. `host.commands` is the surface the core
  // builds for this plugin; a reference taken out of it at mount time is not the surface, and the
  // measured result was that every object call in this kit reached the core while the one
  // destructured call reached nothing — no entry, no refusal, no rejection.
  const put = (command: string, params: Record<string, unknown>, what: string) => {
    const commands = host.commands;
    const execute = commands?.execute;
    if (!execute || !owner) {
      // Nothing to write to, or nothing to write about. Reported at each use rather than once: this
      // writer is held for the life of a pane, and one line at construction is scrolled away long
      // before anyone asks why the index is empty (AGENTS 3-3a).
      console.error(
        `terminal: no core index for ${what} — commands.execute ${execute ? "present" : "absent"}, owner ${owner || "empty"}`,
      );
      return;
    }
    // A refused command answers rather than rejecting: the runner's contract is that every call
    // resolves to {ok:true,…} or {ok:false,code,message}. So a name it does not serve looks exactly
    // like a success to a caller that only catches. Measured: an attach under the wrong name and the
    // wrong parameter produced no log and no entry, and the test that asserted the payload was green
    // over a call that could not land.
    void Promise.resolve(execute.call(commands, command, params))
      .then((outcome) => {
        if ((outcome as { ok?: unknown } | undefined)?.ok === false) {
          console.error(`terminal: the core index refused ${what}`, outcome);
        }
      })
      .catch((error) => console.error(`terminal: the core index did not record ${what}`, error));
  };
  return {
    attach(session, viewId) {
      // The window is not sent. The command stamps the window it ran in, which is the one this view
      // is drawn in — a window named here would be this kit's second answer to that.
      put("session.attach", { session: String(session), owner, view: viewId },
        `session ${session} on view ${viewId}`);
    },
    detach(session) {
      put("session.detach", { session: String(session) }, `the detach of session ${session}`);
    },
  };
}
