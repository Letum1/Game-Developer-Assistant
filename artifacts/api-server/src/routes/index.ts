import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import worldRouter from "./world";
import gameRouter from "./game";
import minerRouter from "./miner";
import walletRouter from "./wallet";
import inventoryRouter from "./inventory";
import storeRouter from "./store";
import leaderboardRouter from "./leaderboard";
import monetizationRouter from "./monetization";
import btcPriceRouter from "./btcPrice";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(worldRouter);
router.use(gameRouter);
router.use(minerRouter);
router.use(walletRouter);
router.use(inventoryRouter);
router.use(storeRouter);
router.use(leaderboardRouter);
router.use(monetizationRouter);
router.use(btcPriceRouter);

export default router;
