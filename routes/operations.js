const express = require("express");
const workersRoutes = require("./workers");
const calendarRoutes = require("./calendar");
const zipGroupsRoutes = require("./zipGroups");
const subscriptionsRoutes = require("./subscriptions");
const notificationsRoutes = require("./notifications");

const router = express.Router();

router.use(workersRoutes);
router.use(calendarRoutes);
router.use(zipGroupsRoutes);
router.use(subscriptionsRoutes);
router.use(notificationsRoutes);

module.exports = router;
