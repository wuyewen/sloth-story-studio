import { Markdown } from "./editor/Markdown";
import helpMd from "../../../../docs/使用指南.md?raw";

export default function HelpPage() {
  return (
    <div className="help-page">
      <div className="help-body">
        <Markdown text={helpMd} />
      </div>
    </div>
  );
}
