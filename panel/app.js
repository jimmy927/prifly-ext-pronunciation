// The "Your accent" window: reads `api/profile` (pronounce/accent-panel.ts) and shows the
// features that set the reader furthest from native speakers, with their own word ("Yours")
// and it said right ("Say it right") to play. A button that cannot play is disabled with
// the reason as its tooltip; none appears or disappears. Its second tab, "Check your flags",
// reads `api/flags` (pronounce/flag-check.ts): the reader scores their past sentences with
// every check and marks each flag Right or Wrong; each check shows its tally (Wrong here and
// "Not a mistake" in the session) beside the switch in Settings that turns it off.

const body = document.getElementById("body");
const heading = document.getElementById("heading");
const refreshButton = document.getElementById("refresh");

const ICON_PLAY = '<path class="icon" d="M5 3.5v9l7-4.5z" />';
const ICON_VOICE = '<path class="icon" d="M2.5 6.5v3M5 4.5v7M7.5 2.5v11M10 5v6M12.5 7v2" />';
const ICON_SPIN = '<path class="spin" d="M8 2.5a5.5 5.5 0 1 0 5.5 5.5" />';

const NUMBERS = ["one", "two", "three"];

/** An element with `className` and text. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function sentences(count) {
  return `${count} dictated sentence${count === 1 ? "" : "s"}`;
}

/** A play button: enabled unless `why` says why not, which is then its tooltip. */
function playButton(label, icon, why, play) {
  const button = el("button", "btn");
  button.type = "button";
  button.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${icon}${ICON_SPIN}</svg>`;
  button.append(label);
  button.disabled = why !== null;
  button.title = why ?? "";
  button.addEventListener("click", () => play(button));
  return button;
}

let current = null;

/** `api/<path>`'s JSON; with `body`, a POST of it. Throws with the extension's error. */
async function api(path, body) {
  const response = await fetch(
    `api/${path}`,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(answer?.error ?? response.statusText);
  return answer;
}

/** Plays `which` of the feature's example; the button spins meanwhile, an error says itself under it. */
async function play(feature, which, button, errorLine) {
  if (button.getAttribute("aria-busy") === "true") return;
  button.setAttribute("aria-busy", "true");
  errorLine.hidden = true;
  try {
    const query = new URLSearchParams({ feature: feature.key, example: feature.example.id, which });
    const { audio } = await api(`play?${query}`);
    await new Audio(audio).play();
  } catch (caught) {
    errorLine.textContent = caught instanceof Error ? caught.message : String(caught);
    errorLine.hidden = false;
  } finally {
    button.removeAttribute("aria-busy");
  }
}

function featureItem(feature, rank, sayRight) {
  const item = el("li", "feature");
  item.append(el("span", "rank", String(rank)));
  item.append(el("h2", "", feature.title));
  item.append(el("p", "distance", feature.distance));
  item.append(el("p", "heard", `Heard in: ${feature.heardIn.join(", ")}`));
  const plays = el("div", "plays");
  const errorLine = el("p", "play-error");
  errorLine.hidden = true;
  const example = feature.example;
  const word = example === null ? "" : `: '${example.word}'`;
  const gone = example === null ? "No example of yours is kept" : null;
  const yours = playButton(`Yours${word}`, ICON_PLAY, gone ?? example.yours, (button) =>
    play(feature, "yours", button, errorLine),
  );
  const right = playButton("Say it right", ICON_VOICE, gone ?? sayRight, (button) =>
    play(feature, "right", button, errorLine),
  );
  yours.dataset.say = `yours ${NUMBERS[rank - 1]}`;
  right.dataset.say = `say it ${NUMBERS[rank - 1]}`;
  plays.append(yours, right);
  item.append(plays, errorLine);
  return item;
}

function collectingLine(view) {
  const line = el("p", "collecting");
  const what = view.collecting === "" ? "nothing yet" : view.collecting;
  line.append(el("b", "", "Not enough yet: "), what);
  return line;
}

/** The heading of the profile tab; the flags tab has its own. */
let profileHeading = "Your accent";

function setHeading(text) {
  profileHeading = text;
  if (tab === "profile") heading.textContent = text;
}

function show(view) {
  current = view;
  body.replaceChildren();
  if (view.sentences === 0) {
    setHeading("Your accent");
    body.append(
      el(
        "p",
        "state",
        "No English dictation yet. Dictate in English as usual, and the sounds that set you apart from native speakers show here.",
      ),
    );
    sayTargets();
    return;
  }
  setHeading(`Your accent, from ${sentences(view.sentences)} in the last ${view.days} days`);
  if (!view.natives) {
    body.append(
      el(
        "p",
        "state",
        "Still collecting: the native speakers' numbers to compare with are not installed yet. Your examples are kept until they are.",
      ),
    );
  } else if (view.features.length === 0) {
    body.append(
      el("p", "state", "Nothing stands out yet. A sound shows here once it has enough examples."),
    );
  } else {
    const list = el("ol", "features");
    view.features.forEach((feature, at) => {
      list.append(featureItem(feature, at + 1, view.sayRight));
    });
    body.append(list);
  }
  if (view.collecting !== "" || view.features.length === 0) body.append(collectingLine(view));
  sayTargets();
}

function showError(message) {
  current = null;
  body.replaceChildren(el("p", "state error", `Could not read your accent profile: ${message}`));
  sayTargets();
}

async function load() {
  // A refresh keeps what is shown until the answer comes; a first read, or one after an error, says it is reading.
  if (current === null) body.replaceChildren(el("p", "state", "Reading your profile…"));
  refreshButton.disabled = true;
  try {
    show(await api("profile"));
  } catch (caught) {
    showError(caught instanceof Error ? caught.message : String(caught));
  } finally {
    refreshButton.disabled = false;
  }
}

// "Check your flags": the scoring job's buttons (always there, enabled by the job's state),
// its line and progress, and every flag by check with Yours, Say it right, Right and Wrong.

const flagsBody = document.getElementById("flags-body");
const scoreButton = document.getElementById("score");
const cancelButton = document.getElementById("cancel");
const resetButton = document.getElementById("reset");
const jobLine = document.getElementById("job-line");
const sensitivityLine = document.getElementById("sensitivity-line");
const progress = document.getElementById("progress");
const progressBar = document.getElementById("progress-bar");
const tabs = {
  profile: {
    button: document.getElementById("tab-profile"),
    panel: document.getElementById("profile-view"),
  },
  flags: {
    button: document.getElementById("tab-flags"),
    panel: document.getElementById("flags-view"),
  },
};

/** How often the page asks again while a job runs, ms. */
const POLL_MS = 1500;

let flagsView = null;
let poll = null;
/** The checks the reader folded: they stay folded when the list is drawn again. */
const closedChecks = new Set();
/** A mark or a play on its way: the buttons stay as they are until it answers. */
let acting = false;

/** The flag's row: its sentence with the word picked out, its score and sound, and its buttons. */
function flagRow(flag, view, errorLine) {
  const row = el("li", "flag-row");
  row.append(el("span", "score", flag.score));
  const sentence = el("p", "sentence");
  sentence.append(flag.before, el("mark", "", flag.word), flag.after);
  row.append(sentence);
  const sound = el("p", "sound", flag.sound);
  if (flag.fix !== "") sound.title = flag.fix;
  row.append(sound);
  const buttons = el("div", "row-buttons");
  const yours = playButton("Yours", ICON_PLAY, view.yours, (button) =>
    playFlag(flag, "yours", button, errorLine),
  );
  const right = playButton("Say it right", ICON_VOICE, view.sayRight, (button) =>
    playFlag(flag, "right", button, errorLine),
  );
  buttons.append(
    yours,
    right,
    verdictButton(flag, "right", "Right"),
    verdictButton(flag, "wrong", "Wrong"),
  );
  row.append(buttons);
  return row;
}

/** Right or Wrong: pressed when it is the reader's verdict; pressing it again takes the verdict back. */
function verdictButton(flag, verdict, label) {
  const button = el("button", `btn verdict ${verdict}`, label);
  button.type = "button";
  const pressed = flag.verdict === verdict;
  button.setAttribute("aria-pressed", String(pressed));
  button.title = pressed ? "Click again to take it back" : `This flag is ${verdict}`;
  button.addEventListener(
    "click",
    () => void act("flags/mark", { id: flag.id, verdict: pressed ? null : verdict }),
  );
  return button;
}

async function playFlag(flag, which, button, errorLine) {
  if (button.getAttribute("aria-busy") === "true") return;
  button.setAttribute("aria-busy", "true");
  errorLine.hidden = true;
  try {
    const { audio } = await api("flags/play", { id: flag.id, which });
    await new Audio(audio).play();
  } catch (caught) {
    errorLine.textContent = caught instanceof Error ? caught.message : String(caught);
    errorLine.hidden = false;
  } finally {
    button.removeAttribute("aria-busy");
  }
}

function checkSection(check, view) {
  const section = el("details", `check ${check.on ? "switched-on" : "switched-off"}`);
  section.open = !closedChecks.has(check.id);
  section.dataset.check = check.id;
  section.addEventListener("toggle", () => {
    if (section.open) closedChecks.delete(check.id);
    else closedChecks.add(check.id);
  });
  const summary = el("summary", "check-head");
  summary.append(el("h2", "", check.title));
  summary.append(el("span", "badge", check.on ? "On" : "Off in Settings"));
  summary.append(
    el(
      "span",
      "tally",
      `${check.flags.length} flag${check.flags.length === 1 ? "" : "s"} · ${check.marked} marked · ${check.wrong} wrong`,
    ),
  );
  section.append(summary);
  section.append(el("p", "result", check.line));
  const errorLine = el("p", "play-error");
  errorLine.hidden = true;
  if (check.flags.length === 0) {
    section.append(el("p", "none", "No flags of this check in the sentences scored."));
  } else {
    const list = el("ol", "flag-rows");
    for (const flag of check.flags) list.append(flagRow(flag, view, errorLine));
    section.append(list);
  }
  section.append(errorLine);
  return section;
}

/** The job's buttons, line and progress bar; whether it is running. */
function showJob(view) {
  scoreButton.disabled = acting || !view.canStart;
  cancelButton.disabled = acting || !view.canCancel;
  resetButton.disabled = acting || !view.canReset;
  const { state, done, total, line } = view.job;
  jobLine.textContent = line;
  jobLine.className = `job-line${state === "failed" ? " error" : ""}`;
  sensitivityLine.textContent = view.sensitivity ?? "";
  const running = state === "running" || state === "listing";
  progress.classList.toggle("active", running);
  progressBar.style.width = total > 0 ? `${Math.round((done / total) * 100)}%` : "0%";
  return running;
}

/** What the list says with no flags in it; "" where the job's line says it all. */
function noFlagsLine(state) {
  if (state === "done" || state === "cancelled") return "No flags in the sentences scored.";
  return state === "idle" ? "Nothing scored yet." : "";
}

function showFlags(view) {
  flagsView = view;
  const running = showJob(view);
  const flagged = view.checks.some((check) => check.flags.length > 0);
  flagsBody.replaceChildren();
  if (flagged) {
    for (const check of view.checks) flagsBody.append(checkSection(check, view));
  } else if (noFlagsLine(view.job.state) !== "") {
    flagsBody.append(el("p", "state", noFlagsLine(view.job.state)));
  }
  clearTimeout(poll);
  poll = running && tab === "flags" ? setTimeout(() => void loadFlags(), POLL_MS) : null;
  sayTargets();
}

function showFlagsError(message) {
  flagsView = null;
  jobLine.textContent = `Could not read your flags: ${message}`;
  jobLine.className = "job-line error";
  scoreButton.disabled = true;
  cancelButton.disabled = true;
  resetButton.disabled = true;
  sayTargets();
}

async function loadFlags() {
  if (flagsView === null) jobLine.textContent = "Reading your flags…";
  try {
    showFlags(await api("flags"));
  } catch (caught) {
    showFlagsError(caught instanceof Error ? caught.message : String(caught));
  }
}

/** An action on the job or a flag; the view it answers with is shown, an error says itself on the job line. */
async function act(path, body) {
  if (acting) return;
  acting = true;
  scoreButton.disabled = cancelButton.disabled = resetButton.disabled = true;
  try {
    const view = await api(path, body);
    acting = false;
    showFlags(view);
  } catch (caught) {
    acting = false;
    if (flagsView !== null) showFlags(flagsView);
    jobLine.textContent = caught instanceof Error ? caught.message : String(caught);
    jobLine.className = "job-line error";
  }
}

scoreButton.addEventListener("click", () => void act("flags/start", {}));
cancelButton.addEventListener("click", () => void act("flags/cancel", {}));
resetButton.addEventListener("click", () => void act("flags/reset", {}));
scoreButton.dataset.say = "score";
cancelButton.dataset.say = "cancel";
resetButton.dataset.say = "reset marks";

const TAB_KEY = "accent-tab";
let tab = "profile";

function showTab(name) {
  tab = name;
  for (const [key, one] of Object.entries(tabs)) {
    one.button.setAttribute("aria-selected", String(key === name));
    one.panel.hidden = key !== name;
  }
  heading.textContent = name === "flags" ? "Check your flags" : profileHeading;
  refreshButton.title = name === "flags" ? "Read your flags again" : "Read your profile again";
  try {
    localStorage.setItem(TAB_KEY, name);
  } catch {
    // No storage in this window: the tab is not remembered.
  }
  if (name === "flags") void loadFlags();
  else clearTimeout(poll);
  sayTargets();
}

tabs.profile.button.addEventListener("click", () => showTab("profile"));
tabs.flags.button.addEventListener("click", () => showTab("flags"));
tabs.profile.button.dataset.say = "profile";
tabs.flags.button.dataset.say = "check flags";

refreshButton.addEventListener("click", () => void (tab === "flags" ? loadFlags() : load()));
refreshButton.dataset.say = "refresh";

// Voice commands ("panel-voice"): the window asks for the names, and says one to click it.
function sayTargets() {
  const targets = [...document.querySelectorAll("[data-say]")]
    .filter((button) => !button.disabled)
    .map((button) => {
      const box = button.getBoundingClientRect();
      return {
        id: button.dataset.say,
        name: button.dataset.say,
        rect: { x: box.x, y: box.y, width: box.width, height: box.height },
      };
    });
  parent.postMessage({ type: "prifly-say-targets", targets }, "*");
}

const LOOK = {
  "--background": "--bg",
  "--foreground": "--fg",
  "--card": "--card",
  "--muted": "--muted",
  "--muted-foreground": "--muted-fg",
  "--border": "--border",
  "--accent": "--accent",
  "--primary": "--primary",
  "--primary-foreground": "--primary-fg",
  "--font-sans": "--font",
};

addEventListener("message", (event) => {
  const data = event.data;
  if (data?.type === "prifly-say-list") return sayTargets();
  if (data?.type === "prifly-say") {
    const button = document.querySelector(`[data-say="${CSS.escape(String(data.id))}"]`);
    if (button instanceof HTMLButtonElement && !button.disabled) button.click();
    return;
  }
  if (data?.type !== "prifly-look") return;
  document.documentElement.dataset.theme = data.dark === true ? "dark" : "light";
  for (const [theirs, ours] of Object.entries(LOOK)) {
    const value = data.tokens?.[theirs];
    if (typeof value === "string" && value !== "") {
      document.documentElement.style.setProperty(ours, value);
    }
  }
});

void load();
{
  let kept = null;
  try {
    kept = localStorage.getItem(TAB_KEY);
  } catch {
    // No storage: the profile first.
  }
  if (kept === "flags") showTab("flags");
}
