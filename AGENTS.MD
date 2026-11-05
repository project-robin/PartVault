 ## Disk-safety rules

  Before cloning repositories, installing dependencies, downloading browsers/SDKs,
  building containers, creating virtual environments, or starting disk-heavy work:

  1. Run:
     df -h /
     btrfs filesystem usage /
     du -sx --block-size=1M "$PWD" 2>/dev/null || true

  2. Stop and ask for approval when:
     - available space is below 15 GiB;
     - the planned operation may leave less than 15 GiB available;
     - Btrfs device-unallocated space is below 2 GiB while metadata is above 85%;
     - the operation may download or generate more than 2 GiB.

  3. Only one agent may install project dependencies at a time.

  4. Reuse existing virtual environments, browser installations, package stores,
     and dependency directories when compatible. Do not independently download
     duplicate Chromium, Playwright, Android SDK, or compiler installations.

  5. For jobs expected to write more than 1 GiB, recheck disk usage every 10 minutes.

  6. Never delete files automatically. Before cleanup:
     - show the exact path;
     - show its size;
     - explain whether it is reproducible;
     - request explicit approval.

  7. After completing disk-heavy work, report:
     - available space before and after;
     - project size before and after;
     - new cache/build directories;
     - individually reviewable cleanup candidates.

  A particularly useful rule is to give each agent a maximum disk budget—perhaps 5 GB—unless you explicitly approve more.

  ### 3. Avoid duplicated agent environments

  When several agents work concurrently:

  - Let one agent perform dependency installation.
  - Share the same project environment when safe.
  - Prefer Git worktrees over full repository clones because they share Git objects.
  - Be aware that each worktree may still get another complete node_modules.
  - Avoid letting multiple agents each install Playwright, Chromium, Android SDKs, or Python environments.
  - Use one package manager consistently per project.
  - Do not run npm install, bun install, and pnpm install in the same project unless intentional.

  ### 4. Monitor; do not automatically delete

  A weekly READ-ONLY review should check:

  df -h /
  btrfs filesystem usage /
  du -x -h --max-depth=1 /home/map | sort -h
  journalctl --disk-usage
  docker system df
  podman system df

  Only run the Docker or Podman command that exists on the machine.

  Useful areas to review regularly:

  - ~/.cache
  - ~/.npm
  - ~/.bun
  - project node_modules
  - project .next, dist, build, and coverage directories
  - Python .venv directories
  - browser automation downloads
  - container images
  - /var/cache
  - system journal usage

  Automatic alerts are good. Automatic deletion is not: an agent could remove an active environment or expensive model download.

  ### 5. Use official cleanup commands

  When explicitly approved:

  - Go build cache: go clean -cache
  - DNF packages: sudo dnf clean packages
  - Containers: inspect with docker system df or podman system df before any prune
  - Flatpak: review flatpak uninstall --unused output before confirming
  - Journals: apply a conservative limit only after checking current usage

  Do not automatically run:

  - go clean -modcache
  - docker system prune -a
  - podman system prune -a
  - recursive deletion of ~/.cache
  - deletion of browser profiles
  - deletion of an entire Android SDK

  Those can remove important or expensive-to-rebuild data.
