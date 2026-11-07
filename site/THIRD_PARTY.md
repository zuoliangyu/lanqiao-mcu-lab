# 参考资料与来源

本项目的网页、CPU解释器及外设模型为本次任务新实现，使用MIT许可证。运行时没有第三方JavaScript库、CDN、网络服务或字体依赖。

- STC MCU 官方 [STC15F2K60S2 系列数据手册](https://stcmicro.com/datasheet/STC15F2K60S2-en.pdf)：用于指令、特殊功能寄存器和定时器设计。
- 用户提供的 `SCH_V40.pdf`、官方BSP、课程大模板及全模块测试例程：用于确定开发板连接、常用驱动方式和兼容性验证。原始资料、课程代码及HEX不随交付包分发；其权利归各原权利人。
- 用户已有 `lanqiao-embedded-lab`：作为浅色功能面板的布局和交互方向参考；未改动该项目。

开发时使用Node.js、CodeGraph和Playwright CLI进行本地分析与验证，这些工具不是网页运行依赖，也不包含在交付包中。
