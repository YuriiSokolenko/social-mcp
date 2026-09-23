# Threads MCP Tool Contract

Status: Draft for Phase 1

## Design rules

- Tool names are explicit and platform-prefixed.
- Read tools never mutate Threads state.
- Write tools are separated clearly and require explicit user intent before invocation.
- Platform API details stay inside the Threads adapter.
- MCP responses use stable project models where practical, while preserving platform IDs needed for follow-up operations.
- Missing permissions/capabilities return a clear capability/permission error rather than silently degrading.
- Pagination is explicit.

## Capability tool

### `threads_capabilities`

Returns the capabilities currently available to the connected account/app, based on configured scopes and verified API access.

Input: none.

Output includes booleans/capability names for profile, posts, replies, insights, search, mentions, publish, reply management, repost/quote and delete where applicable.

This allows an agent to discover what it can actually do instead of assuming permissions.

## Read tools

### `threads_get_profile`

Return the connected Threads profile.

Input: none.

Output: platform user ID, username and other profile fields available to the app.

### `threads_list_posts`

List posts belonging to the connected account.

Input:

- `limit` — bounded page size;
- `cursor` — optional pagination cursor.

Output:

- `items`;
- `next_cursor` when another page exists.

### `threads_get_post`

Return one accessible Threads post.

Input:

- `post_id`.

### `threads_list_replies`

List accessible replies for a post.

Input:

- `post_id`;
- `limit`;
- `cursor`.

### `threads_get_insights`

Return available insights for the connected account or a specific content item.

Input:

- `post_id` — optional;
- `metrics` — optional requested metric names;
- time/range parameters only where supported by the API.

The adapter validates metric combinations against current Threads API capabilities.

### `threads_search`

Search Threads content where the connected application has the required permission.

Input:

- `query`;
- `limit`;
- `cursor`.

### `threads_list_mentions`

List accessible mentions of the connected account.

Input:

- `limit`;
- `cursor`.

## Write tools

These tools change external state. The caller must have explicit user intent before invoking them.

### `threads_publish`

Publish new Threads content.

Input is a discriminated content model supporting only formats implemented and permitted by the current API, initially:

- text;
- image;
- video;
- carousel.

Common input includes:

- `text`;
- media URL(s) where required;
- supported reply/audience/location options only when implemented.

Output includes the created Threads object ID and publication status.

### `threads_reply`

Publish a reply.

Input:

- `post_id`;
- `text`;
- optional supported media.

### `threads_repost`

Repost accessible content when supported/permitted.

Input:

- `post_id`.

### `threads_quote`

Create a quote post when supported/permitted.

Input:

- `post_id`;
- `text`;
- optional supported media.

### `threads_delete`

Delete content owned by the connected account when the permission/API supports it.

Input:

- `post_id`.

### `threads_manage_reply`

Perform supported moderation/management actions on a reply.

Input:

- `reply_id`;
- `action` from an explicit enum of implemented API actions.

## Common response/error model

Successful tool results should expose normalized data plus platform IDs needed by later tools.

Expected error categories:

- `authentication_required`
- `permission_required`
- `capability_unavailable`
- `invalid_request`
- `not_found`
- `rate_limited`
- `platform_error`
- `temporary_failure`

Errors should include a safe human-readable message and, where useful, whether retrying may succeed. Secrets/tokens must never be returned.

## Confirmation boundary

The MCP server does not invent user approval.

Read tools may execute directly. Write tools may execute only when the MCP client/agent is acting on explicit user intent for that state change. Destructive actions such as deletion should receive especially clear confirmation at the client/agent layer.

## Phase 1 implementation order

1. `threads_capabilities`
2. `threads_get_profile`
3. `threads_list_posts`
4. `threads_get_post`
5. `threads_list_replies`
6. `threads_get_insights`
7. `threads_search` / `threads_list_mentions`
8. `threads_publish`
9. `threads_reply`
10. remaining write/moderation tools

The contract may be refined when implementation validates exact current Threads API fields and permission behavior.
