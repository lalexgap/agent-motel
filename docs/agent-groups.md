# Subject groups

Use groups to keep agents working on a subject together across repositories,
roles, providers, and machines. Each agent belongs to at most one group.
Assignment changes organization without interrupting the agent.

## In the UI

In the hub or classic picker, open the command palette with `ctrl-k`:

- **Create group…** creates an empty group. Enter a lowercase slug such as
  `advertiser-portal`, or `server:advertiser-portal` to create it on a remote.
- **Move agent to group…** assigns the selected agent. Tab cycles known groups;
  typing a new name creates it on the agent's host. Enter `ungrouped` to clear
  its assignment. This is also available through `e`, then `g`.
- **Delete empty group…** removes a definition on its host. Nonempty groups
  cannot be deleted; move or clear their agents first.

The create-agent form also has an optional group field. Type an existing group
or use the arrow keys to cycle groups on the selected host. Changing host clears
that selection.

Press `g` to cycle host, directory, and subject views. Creating or assigning a
subject switches to subject view. Groups sort alphabetically, with Ungrouped
last; existing status/recent/role sorting applies within sections. The selected
agent stays selected when reassigned. Parent-child indentation stays within a
section. Empty definitions appear beneath the agent list when space permits.

Search includes subject names, the detail card always shows membership, and
remote rows in subject view include their host. Exited-agent and role filters
retain their existing behavior; section counts describe visible agents.

## Through an agent or CLI

```sh
am group create advertiser-portal
am group set portal-api advertiser-portal
am group set portal-ui advertiser-portal
am group set server:portal-review advertiser-portal --create
am new portal-tests --group advertiser-portal -m "Test the portal"
am run portal-audit --group advertiser-portal -m "Review permissions"
am ls --group advertiser-portal --json
am group list --json
am group clear portal-review
am group delete unused-subject
```

`create` and `clear` are idempotent. `set` requires an existing group unless
`--create` is passed; `new` and `run` require an existing group. Agent prefixes
and exact aliases work for local assignment, and `host:agent` routes remotely.
Names accept lowercase letters and numbers separated by single hyphens, up to
64 characters. `ungrouped` is reserved for the no-group filter.

`group list` combines local and remote definitions, retaining each definition's
host and member count. `--local-only` restricts discovery to one machine. JSON
returns `{ groups, unreachable }`; each group has `name`, `memberCount`, and an
optional `host`. `am ls --json` retains its array format with an optional `group`
field per agent. `am ls --group ungrouped` finds agents without membership.

## Hosts and persistence

Definitions and membership are owned by the agent's host. Matching slugs on
multiple hosts form one sidebar section. Create/delete acts locally unless
`-H <host>` is used; the UI also accepts `host:group` for those actions. Deleting
an empty definition on one host does not delete it elsewhere. Unavailable or
older hosts are reported by CLI discovery; failed remote edits show an error.
Remote group choices refresh asynchronously, while agent membership travels
through the existing fleet refresh and event stream.

Groups use Bun's built-in SQLite at `~/.agent-manager/groups/groups.sqlite`.
Transactions serialize assignments, deletion, and membership migrations across
processes, with a three-second busy timeout and automatic crash recovery.
Membership is joined into agent state on read and excluded from status-file
writes, so provider hooks cannot undo assignment using a stale state snapshot.
The daemon watches the group directory for fleet updates.

Rename, stop/resume, and directory changes preserve membership. Handoffs inherit
the source group. Move/clone transfers it and creates the destination definition;
a grouped push refuses an older destination before stopping the source. Removal
checks that a move's source membership still matches the transferred snapshot;
if it changed during transfer, the move reports an error and retains both copies
for reconciliation instead of dropping the newer assignment. Ordinary removal
and garbage collection snapshot membership in trash, and restore recreates the
definition if necessary. New agents otherwise do not inherit their parent's
group. Existing agents remain ungrouped without a migration.

Group renaming, multiple memberships, nesting, bulk messaging, and group-level
instructions are outside this first version.
