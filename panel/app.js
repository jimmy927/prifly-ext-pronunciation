// The "Your accent" window: reads `api/profile` (pronounce/accent-panel.ts) and shows the
// features that set the reader furthest from native speakers, with their own word ("Yours")
// and it said right ("Say it right") to play. A button that cannot play is disabled with
// the reason as its tooltip; none appears or disappears.

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

async function api(path) {
  const response = await fetch(`api/${path}`);
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

function show(view) {
  current = view;
  body.replaceChildren();
  if (view.sentences === 0) {
    heading.textContent = "Your accent";
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
  heading.textContent = `Your accent, from ${sentences(view.sentences)} in the last ${view.days} days`;
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

refreshButton.addEventListener("click", () => void load());
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
