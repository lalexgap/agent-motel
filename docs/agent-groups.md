# Proposal: subject groups for agents

Status: design sketch for a first implementation. The commands and UI below
are proposed; this PR does not implement them.

Agents working on the advertiser portal should appear together even when they
use different repositories, roles, providers, or machines. Add named groups
that people can manage in the hub and agents can manage through `am`.

## First version

- An agent belongs to zero or one subject group. Moving it replaces its group.
- Groups have a unique lowercase slug, such as `advertiser-portal`. Accept
  letters, numbers, and internal hyphens, up to 64 characters. Reserve
  `ungrouped` for the no-group filter.
- Groups can exist before they have members. Removing an agent leaves its
  group intact. Deleting a nonempty group fails with guidance to move or clear
  its members first.
- Groups organize agents; roles and reporting relationships keep their existing
  meaning. Assignment never interrupts a session or sends it a message.
- No automatic inheritance from the spawning agent in v1. A caller chooses a
  group explicitly, avoiding accidental assignment of unrelated follow-up work.

## Hub and picker

Add **Subjects** to the existing `g` grouping cycle: host → directory → subject.
Keep the current default, and switch to subject view after a successful group
creation or assignment. Both the split hub and classic picker use the same
actions and rendering.

```text
advertiser-portal · 3
  ● portal-api              cdx
  ○ portal-ui               cld
  ⚠ portal-review           cdx

billing · 1
  ● invoices                cld

Ungrouped · 2
  ○ docs                    cld
  ○ cleanup                 cdx
```

The command palette exposes:

| Action | Interaction |
| --- | --- |
| Create group… | Enter a slug and choose a host; local is the default. |
| Move agent to group… | Choose from existing subjects, Ungrouped, or New group…. |
| Delete empty group… | Choose a group and its host; show an error if it has members. |
| Group by subject | Select subject view directly. |

Put **Move to group…** in the selected agent's edit menu too. The destination
picker shows the current group, supports typing to filter, and lets Esc cancel
without changing anything. **New group…** creates and assigns on the selected
agent's host. The create-agent form gains an optional group field, populated
for its selected host; changing host refreshes the choices.

In subject view, render alphabetical sections with Ungrouped last. Keep the
existing status/recent/role sorting inside each section. Keep the cursor on
the same agent after reassignment; parent-child indentation only applies when
both agents are in the same section. Headers are not attachable agent rows.

Show empty groups with a dim “no agents” placeholder when no search or role
filter is active. Counts reflect visible agents after filtering. Searching
matches the group slug as well as the existing fields, and hides empty
sections. Preserve current exited-agent visibility rules. Always show a subject
header in subject view, including when there is only one section. The detail
card shows group and host in every view; duplicate agent names across hosts
also need a host suffix on their rows.

## CLI for agents and scripts

```sh
am group create advertiser-portal
am group list --json
am group set portal-api advertiser-portal
am group set portal-ui advertiser-portal
am group clear portal-review
am new portal-tests --group advertiser-portal -m "Test the advertiser portal"
am run portal-audit --group advertiser-portal -m "Review portal permissions"
am ls --group advertiser-portal
am ls --group ungrouped --json
am group delete unused-subject
```

`create` is idempotent. `set` requires an existing group on the agent's host;
`--create` explicitly permits creating it as part of assignment. `new` and
`run` reject an unknown group before creating a worktree or session. `clear`
is idempotent. Missing arguments, invalid names, and ambiguous agent prefixes
fail without changing membership.

`group list` defaults to the combined fleet; `--local-only` avoids remote
recursion. JSON returns `{ groups, unreachable }`, where each group has its
slug and a list of `{ host, memberCount }` entries. `am ls --json` keeps its
existing array format and adds an optional `group` field per agent. List
filtering combines with existing role and sort options.

## Across machines

Use AM's existing host-owned storage and SSH routing. Group definitions and
membership live on each agent's host; matching slugs across hosts deliberately
appear as one subject in the combined sidebar. Distinct subjects need distinct
slugs. There is no central server or background metadata replication.

```sh
am -H server group create advertiser-portal
am group set server:portal-api advertiser-portal
# One explicit create-and-assign operation on the agent's host:
am group set server:portal-review advertiser-portal --create
```

Unqualified group creation/deletion acts locally; `-H` selects another host.
The UI makes this host scope explicit. Choosing a subject that only exists on
another host uses `set --create` on the selected agent's host. Deleting a local
empty definition does not delete definitions or members on other hosts.

Fetch remote definitions asynchronously through `group list --json --local-only`
so empty groups are discoverable. Use the existing fleet cache/event patterns,
including stale and unreachable feedback. An offline host's count is unknown,
not zero. Remote writes fail visibly without altering the local view to imply
success; only successful responses update the cache. Unsupported group commands
on older hosts disable their group editing while leaving those agents usable.

## Storage and lifecycle

Add `src/groups.ts` with group definitions under `~/.agent-manager/groups/`
and one membership record per agent under `~/.agent-manager/group-memberships/`.
The group module joins membership into agent rows; it does not store group data
in the status file rewritten by provider hooks. This prevents a stale hook
write from undoing a user's group assignment.

Use atomic file writes and a shared, bounded host-local mutation lock for
create, assign, clear, delete, and lifecycle membership changes. Atomic rename
alone does not prevent an assignment racing an empty-group deletion. Recover
abandoned locks and fail with actionable feedback on lock timeout. Membership
references to missing definitions must remain visible as their named section,
so damaged metadata never makes an agent disappear.

| Operation | Membership behavior |
| --- | --- |
| Stop/resume, directory change | Preserve membership. |
| Rename | Move the membership to the new canonical agent name; aliases still resolve. |
| Provider handoff | Assign the successor to the source group. |
| Move/clone | Include group slug in the transfer; ensure the destination definition exists before assignment. |
| Remove/restore | Snapshot the slug in trash, remove active membership, and recreate/restore it when restored. |
| Garbage collection | Follow removal behavior; retain empty group definitions. |

Transfer and trash payloads gain an optional group field. Legacy payloads and
existing agents remain ungrouped without a migration. When exporting a grouped
agent to a host that cannot preserve group metadata, fail before removing the
source and explain that the destination needs an upgrade. Lifecycle changes
must roll back membership with existing operation rollback, rather than leaving
orphaned records or dropping assignments on a failed rename/move.

Watch both new directories in the daemon and emit fleet-change events for
definition and membership edits, including empty-group changes. Teach the agent
primer and concierge instructions the CLI examples so a request such as “put
the portal agents together” can use the same operations as the UI.

## Implementation slices

1. **Storage and commands:** `src/groups.ts`, path helpers, `commands/group.ts`,
   dispatch/help in `index.ts`, filtering/output in `commands/ls.ts`, and
   `--group` in `new`/`run`. Cover the metadata concurrency contract first.
2. **Fleet and lifecycle:** enrich agent rows, carry membership through
   rename/handoff/move/trash/restore/GC, add directory watches and remote group
   discovery with old-host capability handling.
3. **UI:** extend `GroupMode` and `sectionFor` in `fleet.ts`; add shared picker
   handlers and destination input in `picker.ts`, wired through `index.ts`,
   `commands/ui.ts`, and `commands/fleetActions.ts`. Extend the section renderer
   for empty groups rather than introducing fake attachable agents.
4. **Discoverability:** update README, CLI help, agent primer, and concierge
   instructions together with the shipped commands.

Verify group creation/assignment/clearing/deletion and invalid input; concurrent
assignment/deletion and status updates; lifecycle success and rollback; remote
failure and old-host compatibility; and UI selection/filtering with empty,
single, and multiple groups. Use isolated state directories for tests. Manually
exercise both picker modes at narrow sidebar widths with local and remote
members of the same subject.

Group renaming, multiple memberships/tags, nesting, drag-and-drop, bulk group
messaging, group-level instructions, and HTTP mutation endpoints are follow-ups.
The first delivery is complete when a person can create and assign in the UI,
an agent can do the same via CLI, and both immediately see the same sections.
