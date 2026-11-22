# Draw & Guess: better drawing on phones (tools, smooth lines, fill)

Owner-approved scope: all "must-have" and "nice-to-have" items from the Draw & Guess audit, including the
paint-bucket fill. Everything stays inside `src/games/draw-guess/`. No database migration and no `vercel.json` change.

## What was wrong before

- On 360-px phones the tools fell below the screen (at 360×740 the Undo/size row started at y=764; at 360×640
  even the crayons were hidden). The drawer had to scroll mid-turn.
- Lines were straight segments between sparse points, so fast circles came out as polygons. Extra touch points
  the phone records between frames were ignored.
- Strokes went past the host's point limit without any message. The drawer still saw them, but guessers didn't.
- "Clear" used an eraser icon and wiped the page in one tap. There was no real eraser, fill or redo.
- Only 8 colours, and the drawing format could not hold more than 10.
- Undo while a stroke was still being sent could remove the wrong stroke for everyone else.

## What changed

**Bottom toolbar** (7 buttons, 45×48 px at 360 px wide, 50×48 at 393):
1. **Pencil.** Tap it again to choose one of 4 sizes (Patli, Medium, Moti, Bahut moti). A dot shows the
   current size and colour.
2. **Colour.** Pop-up with 12 round swatches: Kaala, Safed, Laal, Narangi, Peela, Hara, Neela, Aasmani, Jamuni,
   Gulabi, Bhoora, Skin.
3. **Eraser.** Paints the page colour and uses the same 4 sizes.
4. **Fill (paint bucket).** Tap an area to fill it with the current colour.
5. **Undo** and 6. **Redo.** Redo works on whatever was undone, and a new line or fill clears the redo list.
7. **Clear**, which asks "Pakka saaf karein?" with "Rehne do" / "Saaf karo" before wiping.

**Drawer screen fits one screen.**
- The word, a round timer and your score sit in one compact row.
- A one-line guess ticker shows the newest guesses and the number of correct ones.
- The page is sized from the space actually left on screen, with the toolbar under it.
- Checked at 393×852, 360×740 and 360×640. At 360×640 this held even with the ~75 px test-mode banner showing.
- The page scrolls to the top when your turn starts.

**Drawing feel.**
- Pointer events use `touch-action: none` and pointer capture, and ignore a second finger.
- Coalesced pointer events are read for full detail.
- Corners are rounded with short quadratic curves (at most 10 units, so straight lines stay straight).
- The canvas is sized to the device pixel ratio.
- The current stroke shows live under the finger.

**Same picture on every phone (needed for fill).** `raster.ts` draws every item into a 1000×1000 grid of
colour numbers using plain arithmetic, with no browser anti-aliasing. So the grid is identical on every device,
and a fill covers exactly the same pixels everywhere. Screens show the grid scaled to their size.
- Only the stub between the newest stroke's last corner and the finger stays out of the grid until another item
  follows. Because of that, a stroke replayed bit by bit matches a keyframe of the same stroke pixel for pixel.
- Undo uses snapshots, so it is instant for the last 3 items. Further back it redraws from scratch: about 120–150 ms
  for a heavy 60-item page on the test machine.

**Live view.**
- Viewers spread each batch of new points over 240 ms, so lines grow smoothly instead of jumping every quarter second.
- The send rate stays at 250 ms on purpose. Every send makes the host broadcast to every phone, and Supabase
  counts each delivery: the free plan allows 100 events per second for the whole project, averaged over a minute.
  A room of 8 at 4 sends per second is already about 80 events per second while someone draws, so 80–100 ms
  sends (10–12 per second) would trip the limit and disconnect rooms.

**No lost strokes.**
- Points are cleaned up before sending (Ramer–Douglas–Peucker, 1.5 units).
- The page limit went from 12,000 to 24,000 coordinates, and each stroke can hold 2,000 coordinates.
- A very long line carries on as a new stroke from the same spot.
- The drawer's phone checks the same limits as the host, so the two never disagree. When the page is full it says
  "Page bhar gaya! Undo karo ya page saaf karo."
- Safety net: once drawing is quiet for 1.5 s, if the host's copy differs, the drawer's page follows the host.
- Before an undo, redo, clear or fill, any points still waiting are sent first, which fixes the wrong-stroke undo.

**Guessers.**
- Hint letters are now bold outlined boxes. The revealed first letter is turmeric, with an "N akshar" badge.
- The guess box scrolls itself above the keyboard when it gets focus.

**Version safety.**
- The drawing now travels in a new field, `sketch`, which carries `v: 2`. The old `pad` field is sent empty.
- A phone still running old code shows a blank page instead of garbage.
- A new phone talking to an old host shows "Game ka naya version aaya hai… refresh karein". The TV shows the same.
- Old phones' stroke messages (no eraser flag, widths 0–2) still work.
- A game saved by older code (no `items`) starts its page blank instead of crashing.

**Test mode.** Bots now sometimes use the fill as well as lines.

## Files

- `shared.ts`: format v2, 12 colours, 4 widths, limits, encoding, `applyOp`, `simplify`.
- `host.ts` (new): the host's drawing log (stroke/fill/undo/redo/clear) without React.
- `raster.ts` (new): the shared pixel renderer and flood fill.
- `pad.tsx`: the canvas component with live ink and gradual replay.
- `usePad.ts`: replay from `sketch`, plus version checks.
- `PaperPhone.tsx`: toolbar, pop-ups, one-screen drawer layout, guess ticker, hint boxes.
- `Tv.tsx`, `index.tsx`, `bot.ts`: wiring.

## Tests run

- `npx -y tsx docs/testing/qa/draw-guess.test.ts`: 17/17 pass. Covers:
  - encoding and decoding
  - host stroke/fill/undo/redo/clear
  - the redo list being cleared by new drawing
  - phone replay from tails, keyframes and missed updates
  - limits (stroke split, full page, fill cap, refused bad input)
  - old-phone messages and old saved games
  - fill staying inside closed shapes
  - bit-by-bit vs one-shot pixels
  - undo snapshots
  - keyframes not changing pixels
  - eraser
  - a 300-step random session that is always pixel-identical to a fresh render
  - a timing check
- `npm run lint`, `npx tsc --noEmit` and `npm run build`: all green.
- Every existing QA suite (`*.test.ts` and the pglite `*.test.mjs` suites): all green.
- Local dev server, Playwright, phone viewports 393×852, 360×740 and 360×640, test mode with bots plus a second
  tab joined as a guesser:
  - drew lines, used fill, colours, sizes, eraser, undo, redo, and opened and cancelled the clear confirm
  - the drawer's and the guesser's canvases match (2–4 of 10,000 sample pixels differ, all on the live stroke end)
  - the toolbar stays on screen in every viewport
  - no sideways scroll and no script errors
  - a CDP touch drag drew a line without scrolling the page
- `layout-sweep.mjs 360 /games/draw-guess`: 0 issues.

## Not tested

- Real phones (iOS Safari and Android Chrome): finger feel, coalesced events, palm or two-finger behaviour, and
  the keyboard pushing the guess box.
- Real Supabase realtime between separate devices. Locally the transport is the in-browser BroadcastChannel.
  The send rate and message sizes are unchanged or smaller than before (a full keyframe is at most ~48 KB,
  under the 256 KB limit).
- Undo and fill speed on a low-end phone with a very full page.
- The TV screen by eye. It uses the same canvas component.
- A deploy while a game is running (old/new mixing). It is handled in code as described above, but not exercised
  across two builds.
