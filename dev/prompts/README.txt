本模板的文件角色与组装方式（修补版新增）

1. 文件角色分三层：
   - brief.txt / balanced.txt / detailed.txt：档位规则，只写该档独有的改法、禁令、长度上限。
   - shared-scene.txt：DSH 场景约定，三档共用。
   - shared-common.txt：公共规则，三档共用。
2. 组装顺序固定：档位文件 + shared-scene.txt + shared-common.txt = effective-*.txt。
   effective-*.txt 是给模型用的成品。修改了任何源文件后，必须重新拼装出对应的
   effective 文件，不要让两套内容各改各的。
3. 优先级链（冲突时按此取舍）：公共规则 > 档位规则 > 场景约定。
4. tiers.json 是三档元数据（供选择器或加载器读取），band 字段与档位文件里的
   长度公式保持一致；改了长度公式要同步改这里。
5. shared-scene.txt 里有两个 {{...}} 占位符，**运行时由代码填**，不要在文件里写死值：
   - {{workspace}}：这次请求所在会话的工作区绝对路径。拿不到时整行会被删掉（宁可不说，不能说错）。
   - {{environment}}：本机操作系统与终端，由 index.js 的 describeEnvironment() 按 process.platform 生成。
   要改这两个值不在 prompts 里改，改代码；文件里只保留占位符。
6. 长度一律按字符数计（中文、英文、标点都算一个字符），不含首尾空白。
