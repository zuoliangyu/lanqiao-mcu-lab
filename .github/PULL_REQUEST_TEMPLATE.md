## 改了什么

<!-- 一两句话说清楚这个 PR 做了什么。 -->

## 为什么

<!-- 原先是什么行为、和实物哪里不一致，或者哪道题需要这个功能。
     关联 issue 请写 Fixes #123。 -->

## 怎么验证的

<!-- 实际跑过什么 HEX、什么场景。CPU 或外设模型改动请写清楚新增/改动了哪些核心验证。 -->

## 自检

- [ ] `npm run check` 通过
- [ ] `npm test` 通过
- [ ] 改了 CPU、定时器或外设模型的话，有固件时跑过 `npm run test:firmware`
- [ ] 改了根目录的 README / LICENSE / THIRD_PARTY / VALIDATION，同时同步了 `site/` 下的副本
- [ ] 没有提交比赛工程源码、个人 HEX 或资源包
