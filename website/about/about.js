for (const button of document.querySelectorAll("[data-copy-target]")) {
  button.addEventListener("click", async () => {
    const target = document.getElementById(button.dataset.copyTarget);
    if (!target) return;
    try {
      await navigator.clipboard.writeText(target.textContent.trim());
      button.textContent = "Copied";
      setTimeout(() => { button.textContent = "Copy"; }, 1600);
    } catch {
      const selection = getSelection();
      const range = document.createRange();
      range.selectNodeContents(target);
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent = "Selected";
    }
  });
}

const GITHUB_REPO_API_URL = "https://api.github.com/repos/shlokkhemani/rabbithole";
const GITHUB_STARS_CACHE_KEY = "rh-github-stars-v1";
const GITHUB_STARS_CACHE_TTL = 6 * 60 * 60 * 1000;

void loadGithubStars();

async function loadGithubStars() {
  const cached = readGithubStarsCache();
  if (cached) {
    renderGithubStars(cached.count);
    if (Date.now() - cached.updatedAt < GITHUB_STARS_CACHE_TTL) return;
  }
  try {
    const response = await fetch(GITHUB_REPO_API_URL, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) return;
    const count = Number((await response.json())?.stargazers_count);
    if (!Number.isFinite(count) || count < 0) return;
    const value = { count: Math.floor(count), updatedAt: Date.now() };
    try { localStorage.setItem(GITHUB_STARS_CACHE_KEY, JSON.stringify(value)); } catch {}
    renderGithubStars(value.count);
  } catch {}
}

function readGithubStarsCache() {
  try {
    const value = JSON.parse(localStorage.getItem(GITHUB_STARS_CACHE_KEY) || "null");
    if (!Number.isFinite(value?.count) || !Number.isFinite(value?.updatedAt)) return null;
    return value;
  } catch {
    return null;
  }
}

function renderGithubStars(count) {
  const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(count);
  const exact = count.toLocaleString("en-US");
  for (const target of document.querySelectorAll("[data-github-stars]")) {
    target.textContent = compact;
    target.setAttribute("aria-label", `${exact} GitHub stars`);
    target.title = `${exact} GitHub stars`;
    target.hidden = false;
  }
}
