{
  description = "Gnomepit: a card duel on gno.land";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    # The chain/onyx tag: the gno that onyx runs.
    gno = {
      url = "github:gnolang/gno/5cdbc25fcde0b7569911a4e308ae5d2f6e96c399";
      flake = false;
    };
    # make deps copies the gnotif registry realm from here unless GNOTIF_DIR names a checkout.
    gnotif = {
      url = "github:gfanton/gnotif";
      flake = false;
    };
  };

  outputs =
    {
      nixpkgs,
      flake-utils,
      gno,
      gnotif,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        gnoTool =
          {
            pname,
            modRoot ? ".",
            subPackages,
            vendorHash,
          }:
          pkgs.buildGoModule {
            inherit
              pname
              modRoot
              subPackages
              vendorHash
              ;
            version = "chain-onyx";
            src = gno;
            # A vendor directory drops the C sources that zondax/hid and mdbx-go compile.
            proxyVendor = true;
            ldflags = [ "-X github.com/gnolang/gno/gnovm/pkg/gnoenv._GNOROOT=${gno}" ];
            doCheck = false;
          };
        gnoPkg = gnoTool {
          pname = "gno";
          subPackages = [
            "gnovm/cmd/gno"
            "gno.land/cmd/gnokey"
          ];
          vendorHash = "sha256-e1g2y3igU88Z6wkBC7+ab/cxj2Wx2Q2izz8ZDJWzuOQ=";
        };
        gnodevPkg = gnoTool {
          pname = "gnodev";
          modRoot = "contribs/gnodev";
          subPackages = [ "." ];
          vendorHash = "sha256-NCcuYcYXZ4xOY9ttAoDt5B+mLVOuf+lifouaVTg97w8=";
        };
        # gnotif's go.mod asks for Go 1.27.
        gnotifdPkg = (pkgs.buildGoModule.override { go = pkgs.go_1_27; }) {
          pname = "gnotifd";
          version = "main";
          src = gnotif;
          subPackages = [ "cmd/gnotifd" ];
          vendorHash = "sha256-qsA250H3PphNgR2NbLVfirFPj/hHq+wIdvEx4NpMkTw=";
          doCheck = false;
        };
      in
      {
        packages = {
          gno = gnoPkg;
          gnodev = gnodevPkg;
          gnotifd = gnotifdPkg;
        };

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.go
            pkgs.tinygo
            pkgs.nodejs_24
            pkgs.pnpm
            gnoPkg
            gnodevPkg
            gnotifdPkg
          ];
          shellHook = ''
            export GNOTIF_DIR="''${GNOTIF_DIR:-${gnotif}}"
          '';
        };
      }
    );
}
