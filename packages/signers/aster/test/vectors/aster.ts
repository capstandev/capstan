// Aster V3 signing vectors (public data, venue research section 4.5). Every vector was signed three ways (a port of
// the venue's JS demo on ethers, viem, and Foundry cast) with byte-identical results. The signing keys are derived at
// test time from public strings and are never written here.
export const ADDR = {
  user: "0x77c87137A21b2C13B620415Bbb58ACe24b16755B",
  signer: "0x255b19e79F60e1Ed20076Fe195BF5045f3E016C1",
  builder: "0xF516fddd46548e304E1bce4DB32FeA7C294E56d2",
} as const;

export const NONCE_BASE = 1793921875000000; // 2026-11-05T23:37:55Z, microseconds

export const TV1 = {
  msg: "symbol=BTCUSDT&type=LIMIT&side=BUY&timeInForce=GTC&quantity=0.001&price=70000&builder=0xF516fddd46548e304E1bce4DB32FeA7C294E56d2&feeRate=0.0002&asterChain=Mainnet&user=0x77c87137A21b2C13B620415Bbb58ACe24b16755B&signer=0x255b19e79F60e1Ed20076Fe195BF5045f3E016C1&nonce=1793921875000000",
  digest: "0x5471641491f35a72baef90ed378f451c2aadb6c7445b989dd8b0db0064fdb924", // not-a-key
  signature: "0xcc307d1652a5de4239f8f4660399e6d0414cc5a54f5244a694ebb09f2a067e9f2c09c7497757b40fbb5213958ee92bd67b92eae543d2aa0bd8c343797f671bcb1c", // not-a-key
} as const;

export const TV2 = {
  typeString: "ApproveBuilder(string Builder,string MaxFeeRate,string BuilderName,string AsterChain,string User,uint256 Nonce)",
  digest: "0x91334f6520a0f2d41a42b281658a2743fbb867914ef422a23f623ee5264db4ee", // not-a-key
  signature: "0x34e0870fec2be89904122dde5a5d11ef01b298fa950ddc6638bab6583afdb2ab6d38eafb78897c924dd8ff62edad67d1cf04915f7d25f3eef9a47e36f9a2ce4d1b", // not-a-key
} as const;

export const TV3 = {
  typeString:
    "ApproveAgent(string AgentName,string AgentAddress,string IpWhitelist,uint256 Expired,bool CanSpotTrade,bool CanPerpTrade,bool CanWithdraw,string AsterChain,string User,uint256 Nonce)",
  expired: 1796513875000,
  digest: "0x7d3ac815f80f7f1e97f6b669fb100f92bac652d223b1f18fd04a7035a1e990a0", // not-a-key
  signature: "0x7bef221354dc0c7c9c3e0b50bec0ca74717f0f04b91c7f29482107af008274c73f6253c01a0b07a7a705dc88b98d0d4ff3958393b010ef544173070fcb6b9d361b", // not-a-key
} as const;

export const TV4 = {
  digest: "0x8c59f0097766842487930c1b729e438a37226c5e9df50bf3b41c36b01e98c307", // not-a-key
  signature: "0x688e8f8b1a78d2877aa691c22587a78076aff134013ee43fc5f356ffb693d5344d7de8729038f94c1c93f62e0b46316c2c1437edb9678a9d8d64dff39dfd9f241c", // not-a-key
} as const;
