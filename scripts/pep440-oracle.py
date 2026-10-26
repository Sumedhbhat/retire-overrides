# Regenerates test/fixtures/pep440-oracle.json from the reference implementation:
#   uv run --no-project --with packaging==24.2 python scripts/pep440-oracle.py   (from the repository root)
import itertools, json, random
from packaging.version import Version
from packaging.specifiers import SpecifierSet
random.seed(7)
vers = ["0.9","1.0","1.0.0","1.0.1","1.0a1","1.0b2","1.0rc1","1.0.post1","1.0.dev0","1.0a1.dev1","1.0+local.1","1.0+abc","1.1","1.1.0.post2","1.2.3","1.2.3rc1","1.2.10","2.0","2.0.0.dev3","2!0.5","3.0.5","3.1.4","3.1.4.post1","3.1.4+ubuntu1","3.2.0","10.0"]
specs = ["==1.0","==1.0.*","!=1.0.*",">=1.0","<2.0",">1.0","<=1.0","~=1.0","~=1.0.0","~=3.1.0",">=1.0,<2.0","!=1.0.1,>=1.0","<1.0",">1.0.post1","==1.0+local.1","==1.*",">=0",""," >= 1.0 , < 1.2 ","<3.1.4",">=3.0.0,<3.1.4","==3.1.4"]
cmp = [[a,b,(Version(a)>Version(b))-(Version(a)<Version(b))] for a,b in itertools.product(vers,vers)]
sat = [[v,s,Version(v) in SpecifierSet(s, prereleases=True)] for v in vers for s in specs]
json.dump({"cmp":cmp,"sat":sat}, open("test/fixtures/pep440-oracle.json","w"))
print(len(cmp), len(sat))
