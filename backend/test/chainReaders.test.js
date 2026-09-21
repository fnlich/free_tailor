const test = require('node:test');
const assert = require('node:assert/strict');

const { loadFresh } = require('./helpers');

/*
 * The four chain readers, against recorded response bodies.
 *
 * Every parser here is a pure function over an already-decoded JSON value, and
 * that shape was chosen for one reason: **the machine this was written on
 * cannot reach a single blockchain endpoint.** The egress policy refuses
 * mempool.space, blockstream, CoinGecko and every public RPC. A reader whose
 * parsing were tangled up with its fetching could not be exercised at all
 * here - it would ship having never once run.
 *
 * So the bodies below are written from the documented shapes of each API, and
 * these tests pin what this code believes those shapes are. They cannot prove
 * a live endpoint agrees; that is the one thing that has to be checked by hand
 * with a real payment, and the README says so. What they CAN prove is that
 * given those bytes, the right amount is read, the wrong ones are refused, and
 * nothing is credited on a shape this code does not fully understand.
 */

const ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function topicFor(address) {
  return `0x${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
}

/** A log entry the way an EVM node serves one. */
function transferLog(overrides = {}) {
  return {
    address: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    topics: [
      TRANSFER_TOPIC,
      topicFor('0x00000000000000000000000000000000000000ff'),
      topicFor(ADDRESS),
    ],
    // 50 USDT at 6 decimals = 50,000,000 = 0x2faf080
    data: '0x0000000000000000000000000000000000000000000000000000000002faf080',
    blockNumber: '0x12d687',
    transactionHash: '0xaaaa',
    removed: false,
    ...overrides,
  };
}

test('an EVM transfer to our address is read at its exact amount', () => {
  const evm = loadFresh('../dist/services/payments/chain/readers/evm');
  const { ASSETS } = loadFresh('../dist/config/chainAssets');

  const transfers = evm.parseTransferLogs(
    [transferLog()],
    ASSETS['ethereum:USDT'],
    ADDRESS,
    0x12d687 + 20
  );

  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].amountAtomic, '50000000');
  assert.equal(transfers[0].asset, 'ethereum:USDT');
  assert.equal(transfers[0].height, 0x12d687);
  assert.equal(transfers[0].confirmations, 21);
});

test('an EVM log is refused unless it is the right contract, topic and recipient', () => {
  const evm = loadFresh('../dist/services/payments/chain/readers/evm');
  const { ASSETS } = loadFresh('../dist/config/chainAssets');
  const usdt = ASSETS['ethereum:USDT'];
  const parse = (log) => evm.parseTransferLogs([log], usdt, ADDRESS, 999_999);

  // The whole point of matching on the contract: anybody can deploy a token
  // that calls itself Tether USD and emit Transfer events from it all day.
  assert.equal(parse(transferLog({ address: '0xbadc0ffee0000000000000000000000000000000' })).length, 0);

  // A different event that happens to have three topics.
  assert.equal(parse(transferLog({ topics: ['0xdeadbeef', '0x0', topicFor(ADDRESS)] })).length, 0);

  // Somebody ELSE being paid, in the same block, from the same contract.
  assert.equal(
    parse(transferLog({ topics: [TRANSFER_TOPIC, '0x0', topicFor('0x9999999999999999999999999999999999999999')] })).length,
    0
  );

  // A log a reorg took back out is not a payment.
  assert.equal(parse(transferLog({ removed: true })).length, 0);

  // Zero, and unparseable data.
  assert.equal(parse(transferLog({ data: '0x0' })).length, 0);
  assert.equal(parse(transferLog({ data: 'not hex' })).length, 0);
});

test('an EVM recipient topic is matched whatever case the address is written in', () => {
  const evm = loadFresh('../dist/services/payments/chain/readers/evm');
  const { ASSETS } = loadFresh('../dist/config/chainAssets');

  // EIP-55 capitalisation is a checksum, not an identity: the same address
  // written mixed-case and lower-case is one address, and a reader that
  // compared them as strings would miss every payment to a checksummed one.
  const mixedCase = '0x1234567890AbCdEf1234567890aBcDeF12345678';
  const transfers = evm.parseTransferLogs([transferLog()], ASSETS['ethereum:USDT'], mixedCase, 999_999);
  assert.equal(transfers.length, 1);
});

test('an EVM receipt says where a transaction is, or that it is nowhere', () => {
  const evm = loadFresh('../dist/services/payments/chain/readers/evm');

  assert.equal(evm.parseReceiptHeight({ blockNumber: '0x64', status: '0x1' }), 100);
  // Null: the node has never heard of it. Still in the mempool: no block.
  assert.equal(evm.parseReceiptHeight(null), 0);
  assert.equal(evm.parseReceiptHeight({ status: '0x1' }), 0);
  // Reverted. The transaction exists and moved nothing.
  assert.equal(evm.parseReceiptHeight({ blockNumber: '0x64', status: '0x0' }), 0);
});

test('TRON transfers are read by contract address, never by symbol', () => {
  const tron = loadFresh('../dist/services/payments/chain/readers/tron');
  const { ASSETS } = loadFresh('../dist/config/chainAssets');
  const asset = ASSETS['tron:USDT'];
  const address = 'TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb';

  const body = {
    data: [
      {
        transaction_id: 'abc123',
        token_info: { address: asset.contract, decimals: 6, symbol: 'USDT' },
        from: 'TSomebodyElse',
        to: address,
        value: '50000000',
      },
      {
        // A token calling itself USDT from a contract that is not USDT.
        transaction_id: 'fake',
        token_info: { address: 'TFakeContractAddressxxxxxxxxxxxxxxx', symbol: 'USDT' },
        to: address,
        value: '999000000',
      },
      {
        // Somebody else's payment, indexed against the same contract.
        transaction_id: 'other',
        token_info: { address: asset.contract, symbol: 'USDT' },
        to: 'TSomebodyElsesAddress',
        value: '10000000',
      },
    ],
  };

  const transfers = tron.parseTronTransfers(body, asset, address);
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].txid, 'abc123');
  assert.equal(transfers[0].amountAtomic, '50000000');
});

test('a TRON amount that is not a whole number of units is refused', () => {
  const tron = loadFresh('../dist/services/payments/chain/readers/tron');
  const { ASSETS } = loadFresh('../dist/config/chainAssets');
  const asset = ASSETS['tron:USDT'];
  const address = 'TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb';

  for (const value of ['', '12.5', '-5', '1e6', 'lots']) {
    const body = {
      data: [{ transaction_id: 't', token_info: { address: asset.contract }, to: address, value }],
    };
    assert.equal(tron.parseTronTransfers(body, asset, address).length, 0, `accepted "${value}"`);
  }
});

test('TRON block heights are read from the shapes TronGrid actually sends', () => {
  const tron = loadFresh('../dist/services/payments/chain/readers/tron');

  assert.equal(tron.parseTronHeight({ block_header: { raw_data: { number: 61_234_567 } } }), 61_234_567);
  assert.equal(tron.parseTronHeight({}), 0);
  assert.equal(tron.parseTransactionHeight({ blockNumber: 61_234_000 }), 61_234_000);
  // An answer with no block is a transaction that has not landed.
  assert.equal(tron.parseTransactionHeight({}), 0);
});

test('Bitcoin outputs paying us are summed, and change going back is not', () => {
  const bitcoin = loadFresh('../dist/services/payments/chain/readers/bitcoin');
  const { ASSETS } = loadFresh('../dist/config/chainAssets');
  const asset = ASSETS['bitcoin:BTC'];
  const address = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';

  const body = [
    {
      txid: 'tx1',
      status: { confirmed: true, block_height: 870_000 },
      vout: [
        { scriptpubkey_address: address, value: 50_000 },
        // Change going back to the sender. Not ours, and not counted.
        { scriptpubkey_address: 'bc1qsomebodyelse', value: 4_000_000 },
        // A second output to us in the same transaction. Counted.
        { scriptpubkey_address: address, value: 28_622 },
      ],
    },
  ];

  const transfers = bitcoin.parseAddressHistory(body, asset, address, 870_001);
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].amountAtomic, '78622');
  assert.equal(transfers[0].confirmations, 2);
});

test('an unconfirmed Bitcoin transaction is reported, at zero confirmations', () => {
  const bitcoin = loadFresh('../dist/services/payments/chain/readers/bitcoin');
  const { ASSETS } = loadFresh('../dist/config/chainAssets');
  const address = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';

  const body = [
    {
      txid: 'pending',
      status: { confirmed: false },
      vout: [{ scriptpubkey_address: address, value: 78_622 }],
    },
  ];

  const transfers = bitcoin.parseAddressHistory(body, ASSETS['bitcoin:BTC'], address, 870_001);
  // Reported rather than dropped, so the buyer's page can say "we can see it,
  // waiting for confirmations" instead of looking like nothing happened. The
  // settler will not credit it at this depth.
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].confirmations, 0);
  assert.equal(transfers[0].height, 0);
});

test('a reader answers nothing rather than guessing at a shape it does not know', () => {
  const evm = loadFresh('../dist/services/payments/chain/readers/evm');
  const tron = loadFresh('../dist/services/payments/chain/readers/tron');
  const bitcoin = loadFresh('../dist/services/payments/chain/readers/bitcoin');
  const { ASSETS } = loadFresh('../dist/config/chainAssets');

  for (const body of [null, undefined, {}, 'an error page', 42, { error: 'rate limited' }]) {
    assert.equal(evm.parseTransferLogs(body, ASSETS['ethereum:USDT'], ADDRESS, 1).length, 0);
    assert.equal(tron.parseTronTransfers(body, ASSETS['tron:USDT'], 'T1').length, 0);
    assert.equal(bitcoin.parseAddressHistory(body, ASSETS['bitcoin:BTC'], 'bc1q', 1).length, 0);
  }
});

test('the Bitcoin tip is read whether it arrives as a number or as text', () => {
  const bitcoin = loadFresh('../dist/services/payments/chain/readers/bitcoin');
  // mempool.space answers `/blocks/tip/height` with a bare integer, which
  // `response.json()` gives as a number - but a proxy in between can hand back
  // the same thing as a quoted string.
  assert.equal(bitcoin.parseTipHeight(870_123), 870_123);
  assert.equal(bitcoin.parseTipHeight('870123'), 870_123);
  assert.equal(bitcoin.parseTipHeight('not a height'), 0);
  assert.equal(bitcoin.parseTipHeight(null), 0);
});
