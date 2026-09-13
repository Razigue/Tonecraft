/**
 * Fetches the tab reader's soundfont and corrects it, off the main thread.
 *
 * `prepareSoundFont` takes 45-75 ms: it parses the preset data and copies the
 * 40 MB file. On the page that is several frames with the UI frozen, where the
 * rule is 8 ms (CLAUDE.md section 4). Here it costs nothing the player sees,
 * and the result is transferred back, not copied.
 */
import { prepareSoundFont } from './soundfont.ts';

interface Scope {
  onmessage: ((e: MessageEvent<string>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}
const scope = self as unknown as Scope;

scope.onmessage = async (e) => {
  try {
    const response = await fetch(e.data);
    if (!response.ok) throw new Error(`the instruments did not load (HTTP ${response.status})`);
    const { bytes } = prepareSoundFont(new Uint8Array(await response.arrayBuffer()));
    scope.postMessage({ bytes }, [bytes.buffer]);
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
