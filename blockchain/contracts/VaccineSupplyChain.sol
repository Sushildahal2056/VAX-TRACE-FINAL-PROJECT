// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title Vaccine distribution ledger
/// @notice Each batch gets a unique digital identity. Custody, cold-chain and
///         administration events are immutable. Beneficiary PII never appears
///         on-chain — only SHA-256 hashes of off-chain records.
contract VaccineSupplyChain is AccessControl {
    bytes32 public constant MANUFACTURER_ROLE = keccak256("MANUFACTURER_ROLE");
    bytes32 public constant LOGISTICS_ROLE = keccak256("LOGISTICS_ROLE");
    bytes32 public constant WAREHOUSE_ROLE = keccak256("WAREHOUSE_ROLE");
    bytes32 public constant CLINIC_ROLE = keccak256("CLINIC_ROLE");
    bytes32 public constant REGULATOR_ROLE = keccak256("REGULATOR_ROLE");
    bytes32 public constant IOT_ORACLE_ROLE = keccak256("IOT_ORACLE_ROLE");

    enum Status {
        None,
        Registered,
        Packaged,
        InTransit,
        InWarehouse,
        Delivered,
        Administered,
        Recalled
    }

    enum EventType {
        Registered,
        Packaged,
        TransferInitiated,
        CustodyAccepted,
        TransportRecorded,
        StorageRecorded,
        TemperatureReading,
        DoseAdministered,
        AdverseEvent,
        Violation,
        Recalled,
        ExceptionAuthorised
    }

    struct Batch {
        uint256 id;
        bytes32 digitalId;
        string vaccineName;
        string lotNumber;
        address manufacturer;
        address currentCustodian;
        uint64 manufacturedAt;
        uint64 expiresAt;
        int16 tempMinCenti;
        int16 tempMaxCenti;
        uint32 vialCount;
        uint32 remainingVials;
        Status status;
        bool coldChainBreached;
        bool exists;
    }

    struct PendingTransfer {
        address from;
        address to;
        uint64 initiatedAt;
        uint64 expectedDeliveryBy;
        bool pending;
    }

    struct LifecycleEvent {
        EventType eventType;
        address actor;
        uint64 timestamp;
        int16 temperatureCenti;
        bytes32 offChainHash;
        string note;
    }

    struct Organisation {
        string name;
        string kind;
        bool registered;
    }

    uint256 public nextBatchId = 1;

    mapping(uint256 => Batch) private _batches;
    mapping(bytes32 => uint256) public digitalIdToBatch;
    mapping(uint256 => PendingTransfer) public pendingTransfers;
    mapping(uint256 => LifecycleEvent[]) private _history;
    mapping(uint256 => bool) public exceptionAuthorised;
    mapping(address => mapping(bytes32 => bool)) private _usedLots;
    mapping(address => Organisation) public organisations;
    address[] private _organisationList;
    mapping(address => bool) private _organisationKnown;

    error BatchNotFound();
    error UnauthorizedActor();
    error InvalidState();
    error TransferAlreadyPending();
    error NoPendingTransfer();
    error NotCustodian();
    error BatchExpired();
    error BatchIsRecalled();
    error DuplicateLot();
    error EmptyVials();
    error InvalidInput();
    error ColdChainBreach();
    error InvalidRecipient();

    event BatchRegistered(uint256 indexed batchId, bytes32 indexed digitalId, address indexed manufacturer, string lotNumber);
    event CustodyTransferInitiated(uint256 indexed batchId, address indexed from, address indexed to, uint64 expectedDeliveryBy);
    event CustodyAccepted(uint256 indexed batchId, address indexed custodian, Status status);
    event ComplianceViolation(uint256 indexed batchId, address indexed actor, string reason);
    event VaccineAdministered(uint256 indexed batchId, bytes32 beneficiaryHash, uint32 remainingVials);
    event BatchRecalled(uint256 indexed batchId, address indexed regulator, string reason);
    event OrganisationSet(address indexed account, string name, string kind);
    event OrganisationDeactivated(address indexed account, string name);

    constructor(address admin) {
        if (admin == address(0)) revert InvalidInput();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function setOrganisation(
        address account,
        string calldata name,
        string calldata kind
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setOrganisation(account, name, kind);
    }

    function registerOrganisation(
        address account,
        string calldata name,
        string calldata kind,
        bytes32 role
    ) external payable onlyRole(DEFAULT_ADMIN_ROLE) {
        _setOrganisation(account, name, kind);
        _clearOperationalRoles(account);
        if (role != bytes32(0)) {
            _grantRole(role, account);
        }
        if (msg.value > 0) {
            (bool ok, ) = account.call{value: msg.value}("");
            if (!ok) revert InvalidInput();
        }
    }

    function deactivateOrganisation(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0) || account == msg.sender) revert InvalidInput();
        if (!organisations[account].registered) revert InvalidInput();
        organisations[account].registered = false;
        _clearOperationalRoles(account);
        emit OrganisationDeactivated(account, organisations[account].name);
    }

    function getOrganisations() external view returns (address[] memory accounts, Organisation[] memory details) {
        accounts = _organisationList;
        details = new Organisation[](accounts.length);
        for (uint256 i = 0; i < accounts.length; i++) {
            details[i] = organisations[accounts[i]];
        }
    }

    function registerBatch(
        string calldata vaccineName,
        string calldata lotNumber,
        uint64 expiresAt,
        int16 tempMinCenti,
        int16 tempMaxCenti,
        uint32 vialCount,
        bytes32 documentHash
    ) external onlyRole(MANUFACTURER_ROLE) returns (uint256 batchId, bytes32 digitalId) {
        if (bytes(vaccineName).length == 0 || bytes(lotNumber).length == 0) revert InvalidInput();
        if (vialCount == 0 || expiresAt <= block.timestamp) revert InvalidInput();
        if (tempMinCenti >= tempMaxCenti) revert InvalidInput();

        bytes32 lotKey = keccak256(bytes(lotNumber));
        if (_usedLots[msg.sender][lotKey]) revert DuplicateLot();
        _usedLots[msg.sender][lotKey] = true;

        batchId = nextBatchId++;
        digitalId = keccak256(
            abi.encode(msg.sender, vaccineName, lotNumber, block.timestamp, batchId)
        );
        digitalIdToBatch[digitalId] = batchId;

        Batch storage b = _batches[batchId];
        b.id = batchId;
        b.digitalId = digitalId;
        b.vaccineName = vaccineName;
        b.lotNumber = lotNumber;
        b.manufacturer = msg.sender;
        b.currentCustodian = msg.sender;
        b.manufacturedAt = uint64(block.timestamp);
        b.expiresAt = expiresAt;
        b.tempMinCenti = tempMinCenti;
        b.tempMaxCenti = tempMaxCenti;
        b.vialCount = vialCount;
        b.remainingVials = vialCount;
        b.status = Status.Registered;
        b.exists = true;

        _append(batchId, EventType.Registered, 0, documentHash, "REGISTERED");
        emit BatchRegistered(batchId, digitalId, msg.sender, lotNumber);
    }

    function recordPackaging(uint256 batchId, bytes32 documentHash) external {
        Batch storage b = _requireBatch(batchId);
        _requireCustodian(b);
        _requireActive(b);
        if (b.status != Status.Registered) revert InvalidState();
        b.status = Status.Packaged;
        _append(batchId, EventType.Packaged, 0, documentHash, "PACKAGED");
    }

    function initiateTransfer(
        uint256 batchId,
        address to,
        uint64 expectedDeliveryBy
    ) external {
        Batch storage b = _requireBatch(batchId);
        _requireCustodian(b);
        _requireActive(b);
        if (to == address(0) || to == msg.sender) revert InvalidInput();
        if (!_validHolder(to)) revert InvalidRecipient();
        if (pendingTransfers[batchId].pending) revert TransferAlreadyPending();
        if (b.remainingVials == 0) revert EmptyVials();
        if (b.status == Status.Registered) {
            b.status = Status.Packaged;
            _append(batchId, EventType.Packaged, 0, bytes32(0), "PACKAGED");
        }

        pendingTransfers[batchId] = PendingTransfer({
            from: msg.sender,
            to: to,
            initiatedAt: uint64(block.timestamp),
            expectedDeliveryBy: expectedDeliveryBy,
            pending: true
        });
        _append(batchId, EventType.TransferInitiated, 0, bytes32(0), "TRANSFER");
        emit CustodyTransferInitiated(batchId, msg.sender, to, expectedDeliveryBy);
    }

    function acceptCustody(uint256 batchId) external {
        Batch storage b = _requireBatch(batchId);
        _requireActive(b);
        PendingTransfer storage p = pendingTransfers[batchId];
        if (!p.pending || p.to != msg.sender) revert NoPendingTransfer();

        if (p.expectedDeliveryBy != 0 && block.timestamp > p.expectedDeliveryBy) {
            _append(batchId, EventType.Violation, 0, bytes32(0), "LATE_DELIVERY");
            emit ComplianceViolation(batchId, msg.sender, "LATE_DELIVERY");
        }

        b.currentCustodian = msg.sender;
        b.status = _statusFor(msg.sender);
        p.pending = false;

        _append(batchId, EventType.CustodyAccepted, 0, bytes32(0), "CUSTODY");
        emit CustodyAccepted(batchId, msg.sender, b.status);
    }

    function recordTransport(
        uint256 batchId,
        int16 temperatureCenti,
        bytes32 readingHash,
        string calldata note
    ) external {
        Batch storage b = _requireBatch(batchId);
        if (!hasRole(LOGISTICS_ROLE, msg.sender) && !hasRole(IOT_ORACLE_ROLE, msg.sender)) {
            revert UnauthorizedActor();
        }
        _requireActive(b);
        _checkTemperature(b, temperatureCenti);
        _append(batchId, EventType.TransportRecorded, temperatureCenti, readingHash, note);
    }

    function recordStorage(
        uint256 batchId,
        int16 temperatureCenti,
        bytes32 readingHash,
        string calldata note
    ) external {
        Batch storage b = _requireBatch(batchId);
        if (!hasRole(WAREHOUSE_ROLE, msg.sender) && !hasRole(IOT_ORACLE_ROLE, msg.sender)) {
            revert UnauthorizedActor();
        }
        _requireActive(b);
        _checkTemperature(b, temperatureCenti);
        _append(batchId, EventType.StorageRecorded, temperatureCenti, readingHash, note);
    }

    function recordTemperature(
        uint256 batchId,
        int16 temperatureCenti,
        bytes32 readingHash
    ) external onlyRole(IOT_ORACLE_ROLE) {
        Batch storage b = _requireBatch(batchId);
        _requireActive(b);
        _checkTemperature(b, temperatureCenti);
        _append(batchId, EventType.TemperatureReading, temperatureCenti, readingHash, "IOT");
    }

    function administerDose(
        uint256 batchId,
        bytes32 beneficiaryHash,
        bytes32 clinicalHash
    ) external onlyRole(CLINIC_ROLE) {
        Batch storage b = _requireBatch(batchId);
        _requireCustodian(b);
        _requireActive(b);
        if (b.status != Status.Delivered && b.status != Status.Administered) revert InvalidState();
        if (b.remainingVials == 0) revert EmptyVials();
        if (b.coldChainBreached && !exceptionAuthorised[batchId]) revert ColdChainBreach();
        if (beneficiaryHash == bytes32(0) || clinicalHash == bytes32(0)) revert InvalidInput();

        unchecked {
            b.remainingVials -= 1;
        }
        if (b.remainingVials == 0) {
            b.status = Status.Administered;
        }
        _append(batchId, EventType.DoseAdministered, 0, beneficiaryHash, "DOSE");
        _append(batchId, EventType.DoseAdministered, 0, clinicalHash, "CLINICAL");
        emit VaccineAdministered(batchId, beneficiaryHash, b.remainingVials);
    }

    function reportAdverseEvent(uint256 batchId, bytes32 reportHash) external {
        _requireBatch(batchId);
        if (!hasRole(CLINIC_ROLE, msg.sender) && !hasRole(REGULATOR_ROLE, msg.sender)) {
            revert UnauthorizedActor();
        }
        if (reportHash == bytes32(0)) revert InvalidInput();
        _append(batchId, EventType.AdverseEvent, 0, reportHash, "AE");
    }

    function recallBatch(uint256 batchId, string calldata reason) external onlyRole(REGULATOR_ROLE) {
        Batch storage b = _requireBatch(batchId);
        if (b.status == Status.Recalled) revert InvalidState();
        b.status = Status.Recalled;
        pendingTransfers[batchId].pending = false;
        _append(batchId, EventType.Recalled, 0, bytes32(0), reason);
        emit BatchRecalled(batchId, msg.sender, reason);
    }

    function authoriseException(uint256 batchId) external onlyRole(REGULATOR_ROLE) {
        _requireBatch(batchId);
        exceptionAuthorised[batchId] = true;
        _append(batchId, EventType.ExceptionAuthorised, 0, bytes32(0), "OVERRIDE");
    }

    function getBatch(uint256 batchId) external view returns (Batch memory) {
        Batch memory b = _batches[batchId];
        if (!b.exists) revert BatchNotFound();
        return b;
    }

    function getBatchByDigitalId(bytes32 digitalId) external view returns (Batch memory) {
        uint256 id = digitalIdToBatch[digitalId];
        if (id == 0) revert BatchNotFound();
        return _batches[id];
    }

    function getHistory(uint256 batchId) external view returns (LifecycleEvent[] memory) {
        if (!_batches[batchId].exists) revert BatchNotFound();
        return _history[batchId];
    }

    function totalBatches() external view returns (uint256) {
        return nextBatchId - 1;
    }

    function verifyAuthenticity(
        uint256 batchId
    ) external view returns (bool genuine, Status status, bool recalled, bool coldChainBreached) {
        Batch storage b = _batches[batchId];
        if (!b.exists) return (false, Status.None, false, false);
        return (true, b.status, b.status == Status.Recalled, b.coldChainBreached);
    }

    function rolesOf(
        address account
    )
        external
        view
        returns (
            bool manufacturer,
            bool logistics,
            bool warehouse,
            bool clinic,
            bool regulator,
            bool iot,
            bool admin
        )
    {
        manufacturer = hasRole(MANUFACTURER_ROLE, account);
        logistics = hasRole(LOGISTICS_ROLE, account);
        warehouse = hasRole(WAREHOUSE_ROLE, account);
        clinic = hasRole(CLINIC_ROLE, account);
        regulator = hasRole(REGULATOR_ROLE, account);
        iot = hasRole(IOT_ORACLE_ROLE, account);
        admin = hasRole(DEFAULT_ADMIN_ROLE, account);
    }

    function _clearOperationalRoles(address account) internal {
        _revokeRole(MANUFACTURER_ROLE, account);
        _revokeRole(LOGISTICS_ROLE, account);
        _revokeRole(WAREHOUSE_ROLE, account);
        _revokeRole(CLINIC_ROLE, account);
        _revokeRole(REGULATOR_ROLE, account);
        _revokeRole(IOT_ORACLE_ROLE, account);
    }

    function _setOrganisation(address account, string calldata name, string calldata kind) internal {
        if (account == address(0) || bytes(name).length == 0 || bytes(kind).length == 0) revert InvalidInput();
        organisations[account] = Organisation(name, kind, true);
        if (!_organisationKnown[account]) {
            _organisationList.push(account);
            _organisationKnown[account] = true;
        }
        emit OrganisationSet(account, name, kind);
    }

    function _requireBatch(uint256 batchId) internal view returns (Batch storage b) {
        b = _batches[batchId];
        if (!b.exists) revert BatchNotFound();
    }

    function _requireCustodian(Batch storage b) internal view {
        if (b.currentCustodian != msg.sender) revert NotCustodian();
    }

    function _requireActive(Batch storage b) internal view {
        if (b.status == Status.Recalled) revert BatchIsRecalled();
        if (b.expiresAt <= block.timestamp) revert BatchExpired();
    }

    function _validHolder(address account) internal view returns (bool) {
        if (!organisations[account].registered) return false;
        return
            hasRole(LOGISTICS_ROLE, account) ||
            hasRole(WAREHOUSE_ROLE, account) ||
            hasRole(CLINIC_ROLE, account) ||
            hasRole(MANUFACTURER_ROLE, account);
    }

    function _statusFor(address account) internal view returns (Status) {
        if (hasRole(CLINIC_ROLE, account)) return Status.Delivered;
        if (hasRole(WAREHOUSE_ROLE, account)) return Status.InWarehouse;
        if (hasRole(LOGISTICS_ROLE, account)) return Status.InTransit;
        return Status.Packaged;
    }

    function _checkTemperature(Batch storage b, int16 temperatureCenti) internal {
        if (temperatureCenti < b.tempMinCenti || temperatureCenti > b.tempMaxCenti) {
            b.coldChainBreached = true;
            _append(b.id, EventType.Violation, temperatureCenti, bytes32(0), "TEMPERATURE");
            emit ComplianceViolation(b.id, msg.sender, "TEMPERATURE");
        }
    }

    function _append(
        uint256 batchId,
        EventType eventType,
        int16 temperatureCenti,
        bytes32 offChainHash,
        string memory note
    ) internal {
        _history[batchId].push(
            LifecycleEvent({
                eventType: eventType,
                actor: msg.sender,
                timestamp: uint64(block.timestamp),
                temperatureCenti: temperatureCenti,
                offChainHash: offChainHash,
                note: note
            })
        );
    }
}
