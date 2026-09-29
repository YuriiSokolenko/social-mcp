import os
import sys

# When tests/ is treated as a package, pytest no longer inserts individual test
# directories into sys.path. Some existing tests rely on ``from conftest import``
# working via rootdir insertion. To preserve backward compatibility, walk test
# subdirectories and add them to sys.path — except tests/threads/, which has its
# own conftest.py that should not shadow the real one.

_tests_dir = os.path.dirname(os.path.abspath(__file__))

for dirpath, dirnames, filenames in os.walk(_tests_dir):
    dirnames[:] = [d for d in dirnames if not d.startswith(".")]
    # Skip tests/threads/ — it has a local conftest.py that would shadow
    # the real conftest used by other test modules.
    rel = os.path.relpath(dirpath, _tests_dir)
    if rel.startswith("threads"):
        continue
    if dirpath not in sys.path:
        sys.path.insert(0, dirpath)
