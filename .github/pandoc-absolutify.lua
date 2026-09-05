-- Pandoc Lua filter: rewrite relative links and images to absolute GitHub URLs.
-- Relative links go to the GitHub blob view; relative images go to raw content.
--
-- The repository is the one publishing the page, not a name written down here: a fork
-- that builds this README would otherwise send every reader of its own site back to
-- the upstream repository, and its "Launch the configurator" button to the upstream
-- demo. Read from the environment the workflow runs in, so the page a repository
-- publishes speaks about that repository. Upstream this changes nothing.
local slug = os.getenv("GITHUB_REPOSITORY") or "kellerlabs/homeracker-community"
local owner, name = slug:match("^([^/]+)/(.+)$")

local repo = "https://github.com/" .. slug
local raw = "https://raw.githubusercontent.com/" .. slug .. "/main/"
local blob = repo .. "/blob/main/"
local pages = "https://" .. owner:lower() .. ".github.io/" .. name .. "/"

-- The demo this README points at, as written upstream
local upstream_pages = "https://kellerlabs.github.io/homeracker-community/"

local function is_relative(url)
  return not url:match("^https?://") and not url:match("^#")
end

function Link(el)
  if is_relative(el.target) then
    el.target = blob .. el.target
  elseif el.target:sub(1, #upstream_pages) == upstream_pages then
    -- The published site links to itself: whoever published it is who it demonstrates
    el.target = pages .. el.target:sub(#upstream_pages + 1)
  end
  return el
end

function Image(el)
  if is_relative(el.src) then
    el.src = raw .. el.src
  end
  return el
end
