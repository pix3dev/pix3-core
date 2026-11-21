// Pix3 agent kit {{version}} — the starter list; edit it (pix3 kit --update leaves an edited file).
//
// The screens of the game worth a look after a UI change: `npx pix3 play --screens` photographs
// each state below in every `--locale` (`all` = the project's) at every `--size`, and writes a
// contact sheet (index.html + sheet.png) and screens.json. Each state is SET, not played to:
//   overrides — the run's RunOverrides: config, storage (a save that opens the shop), seed, ads,
//               reducedMotion
//   scene     — another scene to boot (dev server only): 'res://scenes/ui/result.pix3scene'
//   policy    — a bot in design/tests/bots that walks to the state and calls done(true) on it
//               (the picture is the page on that frame); a state you can set directly needs none
// Add one entry per screen the player can see: the menu, play at its start, a modal, the result.
export default [
  { name: 'start', overrides: {} },
] satisfies ScreenState[];
