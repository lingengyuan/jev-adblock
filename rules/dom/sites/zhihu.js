(globalThis.JevAd ??= {});
(JevAd.siteModules ??= []).push({
  name: "zhihu",
  hosts: ["zhihu.com", "www.zhihu.com", "zhuanlan.zhihu.com", "zhihu.cn", "www.zhihu.cn"],
  detectors: [
    "[class*='feedAd' i]",
    "[class*='feed-ad' i]",
    "[class*='adCard' i]",
    "[class*='ad-card' i]",
    "[id*='feedAd' i]",
    "[class*='advert' i]",
  ],
  labelContainers: ["[class*='feedAd' i]", "[class*='feed-ad' i]", "[class*='adCard' i]"],
  adAncestors: [
    "[class*='feedAd' i]",
    "[class*='feed-ad' i]",
    "[class*='adCard' i]",
    "[class*='ad-card' i]",
  ],
  forceDetectors: [
    ".Banner-adTag-new",
    ".AdvertImg",
    "a.Banner-link",
    // 创作中心卡内的运营轮播位（去投稿/付费咨询卡下方，投放知乎运营 banner 与广告）
    ".CreatorEntrance .Carousel",
  ],
  exclude: [
    "[class*='RecommendSection' i]",
    "[data-za-detail-view-name*='Recommend' i]",
    "[class*='PeopleSection' i]",
    "[class*='AuthorInfo' i]",
  ],
  protectText:
    /推荐关注|你可能感兴趣|发现更多|猜你喜欢|热门讨论|关注的问题|等你来答|邀请你回答|读书|视频回答/i,
  scoreBoost(el) {
    const text = JevAd.text.extractText(el, 300);
    if (/去投稿|赚高收益|付费咨询|知乎知学堂|去咨询|去学习|盐言|开放平台|芝士/.test(text)) {
      return 3;
    }
    return 0;
  },
});
