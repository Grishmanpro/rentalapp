// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @title Advanced Equipment Rental Contract with Geo-zone
/// @notice Per-second billing with pause functionality, geofence check and improved security
contract RentalContract {
    address public owner;
    address public lessor;
    string public equipmentName;
    uint256 public pricePerSecond;
    uint256 public minDeposit;
    bool public isReturnable;

    // Geo-zone parameters
    // Coordinates in 1e6 units (e.g., lat=52345678 means 52.345678°)
    int256 public centerLat;
    int256 public centerLon;
    uint256 public radius;        // in meters
    uint256 public radiusSquared;

    struct Rental {
        address renter;
        uint256 startTime;
        uint256 endTime;
        uint256 deposit;
        uint256 pausedDuration;
        uint256 lastPausedAt;
        bool isActive;
        bool isPaused;
    }

    Rental public activeRental;

    event RentalStarted(address indexed renter, uint256 duration, uint256 deposit);
    event RentalPaused(address indexed renter, uint256 pausedAt);
    event RentalResumed(address indexed renter, uint256 resumeAt);
    event RentalEnded(
        address indexed renter,
        uint256 usedSeconds,
        uint256 amountPaid,
        uint256 refundAmount
    );
    event EmergencyWithdraw(address indexed to, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "Owner only");
        _;
    }

    constructor(
        address _lessor,
        string memory _equipmentName,
        uint256 _pricePerSecond,
        uint256 _minDeposit,
        bool _isReturnable,
        int256 _centerLat,
        int256 _centerLon,
        uint256 _radius
    ) {
        require(_lessor != address(0), "Invalid lessor");
        require(_pricePerSecond > 0, "Invalid price");

        owner = msg.sender;
        lessor = _lessor;
        equipmentName = _equipmentName;
        pricePerSecond = _pricePerSecond;
        minDeposit = _minDeposit;
        isReturnable = _isReturnable;

        centerLat = _centerLat;
        centerLon = _centerLon;
        radius = _radius;
        radiusSquared = _radius * _radius;
    }

    /// @notice Start rental with specified duration within geo-zone
    function rent(
        uint256 duration,
        int256 latE6,
        int256 lonE6
    ) external payable {
        require(!activeRental.isActive, "Already rented");
        require(msg.value >= minDeposit, "Deposit too low");
        require(duration > 0, "Invalid duration");
        require(_withinGeoZone(latE6, lonE6), "Not within allowed zone");

        activeRental = Rental({
            renter: msg.sender,
            startTime: block.timestamp,
            endTime: block.timestamp + duration,
            deposit: msg.value,
            pausedDuration: 0,
            lastPausedAt: 0,
            isActive: true,
            isPaused: false
        });

        emit RentalStarted(msg.sender, duration, msg.value);
    }

    /// @notice Pause active rental
    function pauseRental() external {
        require(activeRental.isActive, "No active rental");
        require(!activeRental.isPaused, "Already paused");
        require(msg.sender == activeRental.renter, "Not renter");

        activeRental.isPaused = true;
        activeRental.lastPausedAt = block.timestamp;

        emit RentalPaused(msg.sender, block.timestamp);
    }

    /// @notice Resume paused rental
    function resumeRental() external {
        require(activeRental.isActive, "No active rental");
        require(activeRental.isPaused, "Not paused");
        require(msg.sender == activeRental.renter, "Not renter");

        activeRental.pausedDuration += block.timestamp - activeRental.lastPausedAt;
        activeRental.isPaused = false;

        emit RentalResumed(msg.sender, block.timestamp);
    }

    /// @notice End rental and settle payments
    function returnEquipment() external {
        require(activeRental.isActive, "No active rental");
        require(msg.sender == activeRental.renter, "Not renter");

        uint256 usedSeconds = calculateUsedTime();
        uint256 amountDue = usedSeconds * pricePerSecond;
        uint256 refundAmount = activeRental.deposit;

        if (amountDue > activeRental.deposit) {
            amountDue = activeRental.deposit;
            refundAmount = 0;
        } else {
            refundAmount = activeRental.deposit - amountDue;
        }

        // Reset state before transfers
        activeRental.isActive = false;

        // Execute transfers
        if (amountDue > 0) {
            payable(lessor).transfer(amountDue);
        }
        if (refundAmount > 0) {
            payable(activeRental.renter).transfer(refundAmount);
        }

        emit RentalEnded(msg.sender, usedSeconds, amountDue, refundAmount);
    }

    /// @dev Calculate actual used time accounting for pauses
    function calculateUsedTime() public view returns (uint256) {
        if (!activeRental.isActive) return 0;

        uint256 baseTime = activeRental.isPaused
            ? activeRental.lastPausedAt
            : block.timestamp;

        uint256 elapsed = baseTime - activeRental.startTime - activeRental.pausedDuration;
        uint256 maxDuration = activeRental.endTime - activeRental.startTime;

        return elapsed > maxDuration ? maxDuration : elapsed;
    }

    /// @notice Get current rental status
    function getStatus() external view returns (string memory) {
        if (!activeRental.isActive) return "Available";
        if (activeRental.isPaused) return "Paused";
        if (block.timestamp > activeRental.endTime) return "Overdue";
        return "Active";
    }

    /// @notice Emergency funds withdrawal (owner only)
    function emergencyWithdraw() external onlyOwner {
        require(!activeRental.isActive, "Active rental exists");
        uint256 balance = address(this).balance;
        payable(owner).transfer(balance);
        emit EmergencyWithdraw(owner, balance);
    }

    /// @dev Check if given coordinates fall within the configured geo-zone
    function _withinGeoZone(int256 latE6, int256 lonE6) internal view returns (bool) {
        int256 dLat = latE6 - centerLat;
        int256 dLon = lonE6 - centerLon;

        // Convert degree diff (1e6) to meters: 1° ≈ 111000 m
        uint256 metersLat = uint256(dLat >= 0 ? dLat : -dLat) * 111000 / 1e6;
        uint256 metersLon = uint256(dLon >= 0 ? dLon : -dLon) * 111000 / 1e6;

        uint256 dist2 = metersLat * metersLat + metersLon * metersLon;
        return dist2 <= radiusSquared;
    }

    receive() external payable {
        revert("Direct payments disabled");
    }
}
