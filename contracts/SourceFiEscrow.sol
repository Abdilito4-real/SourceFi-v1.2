// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title SourceFiEscrow
/// @notice Escrow contract for SourceFi B2B construction materials orders.
///         Buyers deposit USDC for an order; funds release to the supplier
///         on buyer confirmation, platform-arbitrated dispute resolution,
///         or automatic timeout if the buyer never acts.
contract SourceFiEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Funded,
        Disputed,
        Released,
        Refunded
    }

    struct Order {
        address buyer;
        address supplier;
        uint256 amount;
        uint256 fundedAt;
        uint256 deadline;      // fundedAt + autoReleasePeriod
        Status status;
    }

    IERC20 public immutable token;
    address public platform;
    uint256 public autoReleasePeriod = 14 days;
    mapping(bytes32 => Order) public orders;

    event OrderFunded(bytes32 indexed orderId, address indexed buyer, address indexed supplier, uint256 amount, uint256 deadline);
    event DeliveryConfirmed(bytes32 indexed orderId, address indexed buyer);
    event DisputeRaised(bytes32 indexed orderId, address indexed raisedBy, string evidenceURI);
    event DisputeResolved(bytes32 indexed orderId, address indexed resolvedBy, bool releasedToSupplier);
    event AutoReleased(bytes32 indexed orderId);
    event PlatformUpdated(address indexed oldPlatform, address indexed newPlatform);
    event AutoReleasePeriodUpdated(uint256 oldPeriod, uint256 newPeriod);

    error NotPlatform();
    error NotBuyer();
    error NotBuyerOrSupplier();
    error OrderAlreadyExists();
    error OrderNotFound();
    error InvalidStatus();
    error ZeroAddress();
    error ZeroAmount();
    error DeadlineNotReached();

    modifier onlyPlatform() {
        if (msg.sender != platform) revert NotPlatform();
        _;
    }

    constructor(address _token, address _platform) {
        if (_token == address(0) || _platform == address(0)) revert ZeroAddress();
        token = IERC20(_token);
        platform = _platform;
    }

    function fundOrder(bytes32 orderId, address supplier, uint256 amount) external nonReentrant {
        if (supplier == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (orders[orderId].status != Status.None) revert OrderAlreadyExists();

        uint256 deadline = block.timestamp + autoReleasePeriod;

        orders[orderId] = Order({
            buyer: msg.sender,
            supplier: supplier,
            amount: amount,
            fundedAt: block.timestamp,
            deadline: deadline,
            status: Status.Funded
        });

        token.safeTransferFrom(msg.sender, address(this), amount);

        emit OrderFunded(orderId, msg.sender, supplier, amount, deadline);
    }

    function confirmDelivery(bytes32 orderId) external nonReentrant {
        Order storage order = orders[orderId];
        if (order.status == Status.None) revert OrderNotFound();
        if (order.status != Status.Funded) revert InvalidStatus();
        if (msg.sender != order.buyer) revert NotBuyer();

        order.status = Status.Released;
        emit DeliveryConfirmed(orderId, msg.sender);

        token.safeTransfer(order.supplier, order.amount);
    }

    function raiseDispute(bytes32 orderId, string calldata evidenceURI) external {
        Order storage order = orders[orderId];
        if (order.status == Status.None) revert OrderNotFound();
        if (order.status != Status.Funded) revert InvalidStatus();
        if (msg.sender != order.buyer && msg.sender != order.supplier) revert NotBuyerOrSupplier();

        order.status = Status.Disputed;
        emit DisputeRaised(orderId, msg.sender, evidenceURI);
    }

    function resolveDispute(bytes32 orderId, bool releaseToSupplier) external onlyPlatform nonReentrant {
        Order storage order = orders[orderId];
        if (order.status == Status.None) revert OrderNotFound();
        if (order.status != Status.Disputed) revert InvalidStatus();

        order.status = releaseToSupplier ? Status.Released : Status.Refunded;
        emit DisputeResolved(orderId, msg.sender, releaseToSupplier);

        address recipient = releaseToSupplier ? order.supplier : order.buyer;
        token.safeTransfer(recipient, order.amount);
    }

    function autoRelease(bytes32 orderId) external nonReentrant {
        Order storage order = orders[orderId];
        if (order.status == Status.None) revert OrderNotFound();
        if (order.status != Status.Funded) revert InvalidStatus();
        if (block.timestamp < order.deadline) revert DeadlineNotReached();

        order.status = Status.Released;
        emit AutoReleased(orderId);

        token.safeTransfer(order.supplier, order.amount);
    }

    function setPlatform(address newPlatform) external onlyPlatform {
        if (newPlatform == address(0)) revert ZeroAddress();
        address old = platform;
        platform = newPlatform;
        emit PlatformUpdated(old, newPlatform);
    }

    function setAutoReleasePeriod(uint256 newPeriod) external onlyPlatform {
        uint256 old = autoReleasePeriod;
        autoReleasePeriod = newPeriod;
        emit AutoReleasePeriodUpdated(old, newPeriod);
    }

    function getOrder(bytes32 orderId) external view returns (Order memory) {
        return orders[orderId];
    }
}