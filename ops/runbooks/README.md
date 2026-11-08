# Runbooks

What a person does when something breaks. Alerts only notify (`ops/alerts/GLOSSARY.md`); every stop or rollback in
these files is a person's decision.

| Runbook | Use it when |
| --- | --- |
| [incident.md](incident.md) | Any `act` or `critical` ops alert, a service down, wrong quotes, a venue rejecting orders, an anchor mismatch |
| [relay-stop.md](relay-stop.md) | Capstan must stop submitting orders to every venue or to one venue, and to turn it back on |

## Contacts

Roles, not names: this file is public. The owner keeps the list of people in each role, with their handles, in the
private operations notes.

| Role | Reach them | Does |
| --- | --- | --- |
| Owner | the internal ops group, then a direct message | Server steps over ssh: relay flags, deploys, rollbacks; writes anything posted to users |
| Named operator | the internal ops group | Same server steps as the owner, when the owner has named them for it |
| First responder | whoever sees the alert first | Reads the alert, posts the first line, starts incident.md |
| Security reports from outside | GitHub private vulnerability reporting on this repository (SECURITY.md) | Reaches the owner; reply within 72 hours |

The internal ops group is the private Telegram group the `ops-alerts` worker posts to (`ALERTS_CHAT_ID`). Nothing
about an incident goes to the community group until the owner writes it.
