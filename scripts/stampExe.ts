import { rcedit } from "rcedit";

const versionString = {
  FileDescription: "RaphiiWinUtils",
  ProductName: "RaphiiWinUtils",
  InternalFilename: "RaphiiWinUtils",
  InternalName: "RaphiiWinUtils",
  OriginalFilename: "RaphiiWinUtils.exe",
  CompanyName: "Raphiiko"
};

await rcedit("./dist/RaphiiWinUtils.exe", {
  "file-version": "0.1.0",
  "product-version": "0.1.0",
  "version-string": {
    ...versionString
  }
});
