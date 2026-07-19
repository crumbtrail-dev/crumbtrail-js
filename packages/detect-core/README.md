# crumbtrail-detect-core

Side-effect-free project detection and injection planning shared by the
Crumbtrail CLI and cloud automation. It performs read-only filesystem
inspection and produces plans; it does not write files or make network
requests.

The default filesystem implementation shells out to `git` to answer whether a
target file has uncommitted changes. Those calls read the index only
(`rev-parse`, `ls-files -s`); the working-tree comparison is done in process.
That matters because any command which asks git to compare the working tree
against the index makes git hash the file, and hashing runs the file through a
clean filter whose command comes from the repository's own configuration. Cloud
automation supplies its own `InjectIO` and never reaches this code path.

## Behavioral contract

Recipe targeting is a behavioral contract. Changing which file a recipe targets
changes every pull request opened by cloud automation. Any recipe target change
requires a minor version bump at minimum—never a patch release.

Publish after `crumbtrail-core` and `crumbtrail-install-shared`, and before the
`crumbtrail` CLI package.
