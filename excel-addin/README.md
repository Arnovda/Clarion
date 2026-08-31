# Clarion for Excel

A task pane that puts the answer to a saved Clarion question into the sheet
you are looking at.

It is a thin client on purpose. The pane is served by the Clarion frontend at
`/excel-addin`, so there is nothing extra to deploy and nothing that can fall
out of step with the API it calls. This folder holds only the manifest —
the file that tells Excel where to find the pane.

## Setting it up

**1. Point the manifest at your Clarion.** Replace every
`https://clarion.example.com` in `manifest.xml` with your own address. Office
requires HTTPS and refuses to load a pane from a host that is not also listed
under `<AppDomains>`, so both places have to be right.

**2. Give it to Excel.** Pick whichever route matches how your organisation
works:

- **Whole organisation** — upload `manifest.xml` in the Microsoft 365 admin
  centre under *Settings → Integrated apps*. It then appears for everyone you
  deploy it to, with no per-machine step.
- **One Windows machine** — put `manifest.xml` in a shared folder, then in
  Excel: *File → Options → Trust Center → Trust Center Settings → Trusted
  Add-in Catalogs*, add the folder's UNC path, tick *Show in Menu*, restart
  Excel, and find it under *Insert → My Add-ins → Shared Folder*.
- **Mac** — copy `manifest.xml` into
  `~/Library/Containers/com.microsoft.Excel/Data/Documents/wef/` and restart
  Excel.
- **Excel on the web** — *Insert → Office Add-ins → Upload My Add-in*.

**3. Connect it.** In Clarion, open your profile and create a token under
*Access tokens*. Paste it into the pane once. It is stored in Office's roaming
settings, so it follows you to your other machines and is not readable by
anything else in the browser.

## What it can and cannot do

It can list the questions you have saved in Clarion and write one's result
into the active worksheet, starting at A1.

It cannot change anything in Clarion. The whole surface it talks to is three
read-only endpoints, and the token carries exactly your own role — a viewer's
token sees what a viewer sees. Row filters and column masks apply here exactly
as they do on screen; an export that quietly ignored them would make them
meaningless everywhere.

Inserting **clears the sheet first**. A smaller result must not leave rows of
a previous, larger one below it, where they would read as part of the new
answer.

## If something goes wrong

- *"That token is not valid any more"* — it was revoked, it expired, or the
  account was deactivated. Create a new one in Clarion.
- *The pane says it is not running inside Excel* — it was opened in an
  ordinary browser. That is a supported way to check it renders; insertion
  needs Excel.
- *Excel will not load the pane* — almost always the manifest still points at
  `clarion.example.com`, or the address is missing from `<AppDomains>`.
