
// Map device category and subcategory to capabilities
const CAPABILITIES = {
  0: {
    // Mini remote, 1 scene
    17: ['OnOffSwitch', 'BatteryPowered'],
  },
  1: {
    // Dimmer switches
    default: ['MultiLevelSwitch', 'OnOffSwitch'],
  },
  2: {
    // Toggle switches
    default: ['OnOffSwitch'],
  },
  16: {
    17: ['DoorSensor', 'BatteryPowered'],
  },
};

function findCapabilities(category, subcategory) {
  const categoryInfo = CAPABILITIES[category];
  if (!categoryInfo) {
    return [];
  }

  return categoryInfo[subcategory] || categoryInfo.default || [];
}

module.exports = { findCapabilities };
