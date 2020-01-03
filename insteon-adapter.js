
'use strict';

const {
  Adapter,
  Device,
  Event,
  Property,
} = require('gateway-addon');

const { findProductInfo, MessageCommands } = require('insteon-plm');
const fs = require('fs');
const mkdirp = require('mkdirp');
const os = require('os');
const path = require('path');
const storage = require('node-persist');
const delay = require('delay');

const InsteonAPIHandler = require('./insteon-api-handler');
const { findCapabilities } = require('./insteon-capabilities');

const ID_PREFIX = 'insteon-';

function getDataPath() {
  let profileDir;
  if (process.env.hasOwnProperty('MOZIOT_HOME')) {
    profileDir = process.env.MOZIOT_HOME;
  } else {
    profileDir = path.join(os.homedir(), '.mozilla-iot');
  }

  return path.join(profileDir, 'data', 'insteon');
}

function addressToId(address) {
  return ID_PREFIX + address;
}

function idToAddress(id) {
  return id.substring(ID_PREFIX.length);
}

class InsteonProperty extends Property {
  get hub() {
    return this.device.hub;
  }

  get messenger() {
    return this.device.messenger;
  }

  handleMessage(_message) {
  }

  poll() {
  }
}

class OnOffProperty extends InsteonProperty {
  constructor(device) {
    super(device, 'on', {
      '@type': 'OnOffProperty',
      label: 'On/Off',
      name: 'on',
      type: 'boolean',
      value: false,
    });
  }

  handleMessage(message) {
    const { cmd1 } = message;

    if (cmd1 === MessageCommands.ON) {
      this.setCachedValueAndNotify(true);
    } else if (cmd1 === MessageCommands.ON_FAST) {
      this.setCachedValueAndNotify(true);
      this.device.eventNotify(new Event(this.device, 'FastOn'));
    } else if (cmd1 === MessageCommands.OFF) {
      this.setCachedValueAndNotify(false);
    } else if (cmd1 === MessageCommands.OFF_FAST) {
      this.setCachedValueAndNotify(false);
      this.device.eventNotify(new Event(this.device, 'FastOff'));
    }
  }

  async poll() {
    const level = await this.hub.status(this.device.address);
    this.setCachedValueAndNotify(level > 0);
  }

  async setValue(value) {
    if (value) {
      await this.hub.turnOn(this.device.address);
    } else {
      await this.hub.turnOff(this.device.address);
    }

    return value;
  }
}

class DimmerProperty extends InsteonProperty {
  constructor(device) {
    super(device, 'level', {
      '@type': 'LevelProperty',
      label: 'Level',
      name: 'level',
      type: 'integer',
      minimum: 0,
      maximum: 100,
      value: 0,
    });
  }

  handleMessage(message) {
    const { cmd1 } = message;
    if (cmd1 === MessageCommands.ON || cmd1 === MessageCommands.ON_FAST) {
      this.pollWithDelay();
    } else if (cmd1 === MessageCommands.OFF || cmd1 === MessageCommands.OFF_FAST) {
      this.setCachedValueAndNotify(0);
    } else if (cmd1 === MessageCommands.STOP_MANUAL_CHANGE) {
      this.poll();
    }
  }

  async pollWithDelay() {
    await delay(500);
    this.poll().catch((e) => {
      console.warn(`Failed to poll ${this.device.address}: ${e.message}`);
    });
  }

  async poll() {
    const level = await this.hub.status(this.device.address);
    this.setCachedValueAndNotify(Math.round((level / 255) * 100));
  }

  async setValue(level) {
    if (level > 0) {
      this.hub.turnOn(this.device.address, { level });
    } else {
      this.hub.turnOff(this.device.address);
    }

    this.setCachedValueAndNotify(level);

    return level;
  }
}

class OpenProperty extends InsteonProperty {
  constructor(device) {
    super(device, 'open', {
      '@type': 'OpenProperty',
      label: 'Open/Closed',
      name: 'open',
      type: 'boolean',
      readOnly: true,
      value: false,
    });
  }

  handleMessage(message) {
    const { cmd1 } = message;

    if (cmd1 === MessageCommands.ON) {
      this.setCachedValueAndNotify(true);
    } else if (cmd1 === MessageCommands.OFF) {
      this.setCachedValueAndNotify(false);
    }
  }
}

class InsteonDevice extends Device {
  constructor(adapter, id, deviceDescription) {
    super(adapter, id);
    this.title = deviceDescription.name || deviceDescription.title;
    this.description = deviceDescription.description;
    this._address = idToAddress(id);
    const type = this['@type'] = deviceDescription['@type'] || [];

    let isLight = false;
    if (type.includes('OnOffSwitch')) {
      this.properties.set('on', new OnOffProperty(this));
      isLight = true;
    }

    if (type.includes('MultiLevelSwitch')) {
      this.properties.set('level', new DimmerProperty(this));
      isLight = true;

      this.addAction('Fade', {
        '@type': 'FadeAction',
        input: {
          type: 'object',
          required: ['level', 'duration'],
          properties: {
            level: {
              type: "integer",
              unit: "percent",
              minimum: 0,
              maximum: 100
            },
            duration: {
              type: 'integer',
              unit: 'second',
              minimum: 0
            }
          }
        }
      });
    }

    if (type.includes('DoorSensor')) {
      this.properties.set('open', new OpenProperty(this));
    }

    // Add events and actions for fast on/off
    if (isLight) {
      this.addEvent('FastOn', {
        '@type': 'DoublePressedEvent',
        description: 'Double tap on',
      });

      this.addEvent('FastOff', {
        '@type': 'DoublePressedEvent',
        description: 'Double tap off',
      });
    }

    this.poll();
  }

  async performAction(action) {
    switch (action.name) {
      case 'Fade': {
        const { duration, level } = action.input;
        if (level > 0) {
          await this.hub.turnOn(this.address, { level, duration });
        } else {
          await this.hub.turnOff(this.address, { duration });
        }
        break;
      }
      default:
        console.warn(`Unknown action ${action.name}`);
        break;
    }
  }

  get address() {
    return this._address;
  }

  async handleMessage(message) {
    for (const prop of this.properties.values()) {
      await prop.handleMessage(message);
    }
  }

  async poll() {
    for (const prop of this.properties.values()) {
      await prop.poll();
    }
  }

  get hub() {
    return this.adapter.hub;
  }

  get messenger() {
    return this.adapter.messenger;
  }
}

class InsteonAdapter extends Adapter {
  constructor(addonManager, manifest, hub) {
    super(addonManager, 'insteon', manifest.name);
    this.name = 'INSTEON';

    const dataDir = getDataPath();
    if (!fs.existsSync(dataDir)) {
      mkdirp.sync(dataDir, { mode: 0o755 });
    }

    this._hub = hub;

    storage.init({ dir: dataDir });
    addonManager.addAdapter(this);

    this.apiHandler = new InsteonAPIHandler(addonManager, this);

    this.messenger.on('message', (message) => this._handleMessage(message));
  }

  get hub() {
    return this._hub;
  }

  get messenger() {
    return this.hub.messenger;
  }

  _handleMessage(message) {
    const device = this.devices[addressToId(message.from)];
    if (device) {
      device.handleMessage(message);
    }
  }

  async addDeviceByAddress(address, category, subcategory) {
    const info = findProductInfo(category, subcategory);
    const name = (info && info.name) || 'INSTEON Device';

    return this.addDevice(addressToId(address), {
      title: `${name} [${address}]`,
      category,
      subcategory,
    });
  }

  async addDevice(deviceId, deviceDescription) {
    if (deviceId in this.devices) {
      return this.devices[deviceId];
    }

    const { category, subcategory } = deviceDescription;
    if (Number.isInteger(category) && Number.isInteger(subcategory)) {
      deviceDescription['@type'] = findCapabilities(category, subcategory);
    }

    const device = new InsteonDevice(this, deviceId, deviceDescription);
    this.devices[deviceId] = device;
    this.handleDeviceAdded(device);

    device.poll().catch(() => {
      console.warn(`Failed initial poll of ${device.id}`);
    });

    return device;
  }

  async removeDevice(deviceId) {
    if (deviceId in this.devices) {
      const device = this.devices[deviceId];
      delete this.devices[deviceId];

      await storage.removeItem(deviceId);

      this.handleDeviceRemoved(device);
    }
  }

  async handleDeviceSaved(deviceId, device) {
    if (!deviceId.startsWith(ID_PREFIX)) {
      return;
    }

    const info = await storage.getItem(idToAddress(deviceId));
    if (info) {
      await this.addDevice(deviceId, {
        title: device.title,
        '@type': device['@type'],
      });
    }
  }

  async startPairing(timeoutSeconds) {
    super.startPairing(timeoutSeconds);

    this.link({ timeout: timeoutSeconds * 1000 }).then(async (link) => {
      if (link) {
        const device = await this.addDeviceByAddress(link.address, link.category, link.subcategory);
        this.sendPairingPrompt('Linked new device', null, device);
      }
    }, (err) => {
      console.error('Linking failed', err);
    });
  }

  async cancelPairing() {
    super.cancelPairing();

    return this.hub.messenger.modem.cancelAllLinking();
  }

  async removeThing(device) {
    try {
      await this.removeDevice(device.id);
      console.log(`Device ${device.id} was removed.`);
    } catch (err) {
      console.error(`Failed to remove device ${device.id}`, err);
    }
  }

  async unload() {
    await this.hub.close();
  }

  async link({ controller = true, timeout = 30000 } = {}) {
    this.sendPairingPrompt('Press the \'set\' button on the device you would like to link.');
    const info = await this.hub.link(null, { controller, timeout });
    if (!info) {
      console.log('No link information received.');
      return;
    }

    console.log(`Link Result, controller=${controller}`, info);

    if (controller) {
      // We don't get valid device category when controller=false
      await storage.setItem(info.address, info);
    }

    return info;
  }

  async scan() {
    console.log('Attempting to add devices from adapter link database...');

    const addresses = new Set((await this.hub.links()).map((info) => info.address));

    this.sendPairingPrompt(`Found ${addresses.size} devices. Adding things. This may take a while...`);
    console.log('Found addresses from database', addresses);

    const devices = [];
    for (const address of addresses) {
      if (this.devices[addressToId(address)]) {
        // Skip known devices
        continue;
      }

      try {
        const info = await this.hub.productInfo(address);
        await storage.setItem(address, info);

        const device = await this.addDeviceByAddress(address, info.category, info.subcategory);
        devices.push(device.asDict());
      } catch (e) {
        console.error(`Failed to add device ${address}`, e);
      }
    }

    console.log(`Added ${devices.length} devices from database`);
    this.sendPairingPrompt(`Scan complete. Added ${devices.length} devices.`);
    return devices;
  }
}

module.exports = InsteonAdapter;